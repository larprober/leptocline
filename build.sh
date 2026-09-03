#!/usr/bin/env bash
# Build the Larp Linux ISO.
#
# Needs a Debian or Ubuntu host (a VM, a WSL2 distro, or a live stick will do)
# with sudo, ~20 GB free, and a network connection. Expect 25-50 minutes on the
# first run; later runs reuse the apt cache and are much quicker.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$HERE"

B=$'\e[1;38;2;60;110;255m'; K=$'\e[90m'; R=$'\e[1;31m'; N=$'\e[0m'
say()  { printf '\n%s==>%s %s\n' "$B" "$N" "$*"; }
note() { printf '    %s%s%s\n' "$K" "$*" "$N"; }
die()  { printf '\n%serror:%s %s\n\n' "$R" "$N" "$*" >&2; exit 1; }

CLEAN=0
REBUILD=0
FAST=0
ASSETS=1
DEPS=1
for arg in "$@"; do
	case "$arg" in
		--clean)      CLEAN=1 ;;
		--rebuild)    REBUILD=1 ;;
		--fast)       FAST=1 ;;
		--no-assets)  ASSETS=0 ;;
		--no-deps)    DEPS=0 ;;
		-h|--help)
			sed -n '2,6p' "$0" | sed 's/^# \?//'
			echo
			echo "usage: ./build.sh [--clean|--rebuild|--fast] [--no-assets] [--no-deps]"
			echo
			echo "  --clean    discard the chroot AND the package cache (full re-download)"
			echo "  --rebuild  discard the chroot, keep the cache (much faster)"
			echo "  --fast     reuse the chroot, only refresh shipped files and re-pack"
			echo "             (does NOT re-run chroot hooks: no plymouth/initramfs)"
			echo
			exit 0 ;;
		*) die "unknown option: $arg" ;;
	esac
done

# ---------------------------------------------------------------- host checks

say 'checking the build host'

[ "$(uname -s)" = 'Linux' ] || die 'live-build only runs on Linux. Use a Debian/Ubuntu VM or WSL2.'
command -v apt-get >/dev/null 2>&1 || die 'this needs a Debian-family host (apt-get not found).'
note "host: $( (. /etc/os-release && echo "$PRETTY_NAME") 2>/dev/null || uname -sr)"

# The chroot needs real ownership, permissions and device nodes. A Windows
# drive mounted into WSL gives none of those, and the build dies deep inside
# debootstrap with a confusing error, so stop here instead.
FSTYPE=$(stat -f -c %T . 2>/dev/null || echo unknown)
case "$FSTYPE" in
	*9p*|*drvfs*|*fuseblk*|*ntfs*|*msdos*|*exfat*|*smb*|*cifs*|*v9fs*)
		die "this tree is on a $FSTYPE filesystem, which cannot hold a chroot.
       Copy it onto the Linux filesystem first, for example:

         cp -r \"$HERE\" ~/leptocline && cd ~/leptocline && ./build.sh
"
		;;
esac
note "filesystem: $FSTYPE"

AVAIL=$(df -BG --output=avail . | tail -1 | tr -dc '0-9')
[ "${AVAIL:-0}" -ge 15 ] || die "only ${AVAIL}G free here; the build needs about 20G."
note "free space: ${AVAIL}G"

if [ "$(id -u)" -eq 0 ]; then
	SUDO=''
else
	command -v sudo >/dev/null 2>&1 || die 'need root or sudo.'
	SUDO='sudo'
fi

[ -f auto/config ] || die 'auto/config is missing. It must sit at the TOP LEVEL
       of the build tree; live-build ignores it anywhere else.'
# A checkout on a filesystem that drops the exec bit (Windows, some CI) leaves
# our scripts non-executable; restore the bits ourselves rather than demanding
# git preserved them.
chmod +x auto/config build.sh 2>/dev/null || true
find config/hooks/normal -maxdepth 1 -type f -name '*.hook.chroot' -exec chmod +x {} + 2>/dev/null || true
find config/includes.chroot/usr/local/bin config/includes.chroot/usr/bin -maxdepth 1 -type f -exec chmod +x {} + 2>/dev/null || true

SUITE=$(awk -F= '/^SUITE=/{print $2; exit}' auto/config)
SUITE=${SUITE:-trixie}

# ------------------------------------------------------------------ toolchain

if [ "$DEPS" -eq 1 ]; then
	say 'installing build dependencies'
	$SUDO apt-get update
	$SUDO apt-get install -y --no-install-recommends \
		live-build debootstrap squashfs-tools xorriso isolinux syslinux-common \
		grub-pc-bin grub-efi-amd64-bin mtools dosfstools ca-certificates curl gnupg
else
	command -v lb >/dev/null 2>&1 || die 'live-build not installed; drop --no-deps.'
fi
note "live-build: $(lb --version 2>/dev/null || echo unknown)"

# debootstrap only knows the suites its own version shipped with. On a host
# older than the target release it aborts with "No such script"; sid's script
# is the one this suite would have used anyway.
if [ ! -e "/usr/share/debootstrap/scripts/$SUITE" ]; then
	note "debootstrap has no $SUITE script; pointing it at sid"
	$SUDO ln -sf /usr/share/debootstrap/scripts/sid "/usr/share/debootstrap/scripts/$SUITE"
fi
note "target suite: $SUITE"

# --------------------------------------------------------------------- assets

if [ "$ASSETS" -eq 1 ] && command -v node >/dev/null 2>&1; then
	say 'rendering brand assets'
	node tools/render-assets.js
else
	note 'using the committed PNGs (node not found or --no-assets)'
fi

# Git and Windows filesystems both lose the executable bit, and live-build
# silently ignores a hook it cannot execute, which is miserable to debug.
say 'fixing permissions'
chmod +x auto/config
# lb config symlinks live-build's own default hooks in beside ours. Those point
# into /usr/share and are not ours to chmod, so touch real files only.
find config/hooks/normal -maxdepth 1 -type f -name '*.hook.chroot' -exec chmod +x {} + 2>/dev/null || true
find config/includes.chroot/usr/local/bin -maxdepth 1 -type f -exec chmod +x {} +
chmod 0440 config/includes.chroot/etc/sudoers.d/leptocline
note "$(find config/hooks/normal -maxdepth 1 -type f 2>/dev/null | wc -l) own hooks, $(ls config/includes.chroot/usr/local/bin | wc -l) tools"

# ---------------------------------------------------------------------- build

if [ "$CLEAN" -eq 1 ]; then
	say 'cleaning previous build (chroot and package cache)'
	$SUDO lb clean --purge
elif [ "$REBUILD" -eq 1 ]; then
	say 'clearing the built image, keeping the package cache'
	$SUDO lb clean
elif [ "$FAST" -eq 1 ]; then
	[ -d chroot ] || die '--fast needs an existing chroot; build once without it first.'
	say 'fast path: refreshing shipped files inside the existing chroot'
	# Copies config/includes.chroot over the built chroot and re-packs. Good for
	# artwork and config; chroot hooks do not re-run, so plymouth theme changes
	# or anything touching the initramfs still need --rebuild.
	$SUDO cp -a config/includes.chroot/. chroot/
	$SUDO lb clean --binary
fi

say 'configuring'
lb config

# live-build keeps several suite variables (chroot, binary, installer) and each
# one defaults to "testing" independently. Checking only LB_DISTRIBUTION is not
# enough: that passed while the chroot was still being built from testing.
WRONG=$(grep -rhE '^LB_[A-Z_]*DISTRIBUTION[A-Z_]*=' config/ 2>/dev/null \
	| sort -u | grep -v "=\"${SUITE}\"" | grep -v '=""' || true)
if [ -n "$WRONG" ]; then
	echo "$WRONG" >&2
	die "lb config recorded a suite other than ${SUITE} (listed above).
       Every distribution variant must be named explicitly in auto/config."
fi
note "suite: $SUITE (chroot, binary and installer all agree)"
note "archive areas: $(grep -rh '^LB_ARCHIVE_AREAS=' config/ 2>/dev/null | head -1 | cut -d'"' -f2)"

say 'building — this is the long part'
note 'debootstrap, then ~1200 packages, then squashfs, then the ISO'
$SUDO lb build

# ---------------------------------------------------------------------- done

ISO=$(ls -1 ./*.iso 2>/dev/null | head -1 || true)
[ -n "$ISO" ] || die 'the build finished but no ISO appeared; check the log above.'

$SUDO chown "$(id -u):$(id -g)" "$ISO" 2>/dev/null || true
SIZE=$(du -h "$ISO" | cut -f1)

say "built ${ISO#./} (${SIZE})"
cat <<DONE

    ${K}copy it to Windows${N}
      cp ${ISO#./} /mnt/c/Users/canel/

    ${K}try it${N}
      qemu-system-x86_64 -m 4096 -enable-kvm -cdrom ${ISO#./}

    ${K}write it to a USB stick${N} ${R}(this erases the target device)${N}
      lsblk
      sudo dd if=${ISO#./} of=/dev/sdX bs=4M status=progress oflag=sync

    ${K}live session${N}
      user lepto, password live, hostname leptocline

DONE
