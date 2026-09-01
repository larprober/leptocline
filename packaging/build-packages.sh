#!/usr/bin/env bash
# Build the Linux Leptocline Debian packages from the same files the ISO ships,
# so the package contents and the live system can never drift apart.
#
#   leptocline-base     - the lepto/leptofetch commands, branding, theme
#   leptocline-desktop  - metapackage: depends on the whole toolset
#
# Output: packaging/out/*.deb
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
CHROOT="$ROOT/config/includes.chroot"
OUT="$HERE/out"
VERSION="${LEPTO_VERSION:-1.0}"
MAINT="larprober <larprober@users.noreply.github.com>"

rm -rf "$OUT" "$HERE/.stage"
mkdir -p "$OUT"

# ---------------------------------------------------------------- base package
BASE="$HERE/.stage/leptocline-base"
mkdir -p "$BASE/DEBIAN" \
         "$BASE/usr/local/bin" \
         "$BASE/usr/share/leptocline" \
         "$BASE/usr/share/backgrounds/leptocline" \
         "$BASE/usr/share/plymouth/themes/leptocline" \
         "$BASE/usr/share/pixmaps"

cp "$CHROOT/usr/local/bin/lepto"      "$BASE/usr/local/bin/"
cp "$CHROOT/usr/local/bin/leptofetch" "$BASE/usr/local/bin/"
cp -r "$CHROOT/usr/share/leptocline/." "$BASE/usr/share/leptocline/"
cp -r "$CHROOT/usr/share/backgrounds/leptocline/." "$BASE/usr/share/backgrounds/leptocline/"
cp -r "$CHROOT/usr/share/plymouth/themes/leptocline/." "$BASE/usr/share/plymouth/themes/leptocline/"
cp "$CHROOT/usr/share/pixmaps/leptocline.png" "$BASE/usr/share/pixmaps/" 2>/dev/null || true
# icons
for d in "$CHROOT"/usr/share/icons/hicolor/*/apps/leptocline.png; do
  [ -e "$d" ] || continue
  rel=${d#"$CHROOT"/}
  mkdir -p "$BASE/$(dirname "$rel")"
  cp "$d" "$BASE/$rel"
done
chmod 0755 "$BASE/usr/local/bin/lepto" "$BASE/usr/local/bin/leptofetch"

INSTALLED_KB=$(du -sk "$BASE" | cut -f1)
cat > "$BASE/DEBIAN/control" <<CTL
Package: leptocline-base
Version: ${VERSION}
Architecture: all
Maintainer: ${MAINT}
Section: admin
Priority: optional
Installed-Size: ${INSTALLED_KB}
Depends: bash, coreutils
Description: Linux Leptocline base system — branding and control tools
 The lepto control command, the leptofetch system readout, the wallpaper,
 the Plymouth boot theme and the icon set that define Linux Leptocline.
 .
 This package is installed on every Leptocline system and is the anchor the
 leptocline-desktop metapackage depends on.
Homepage: https://github.com/larprober/leptocline
CTL

cat > "$BASE/DEBIAN/postinst" <<'CTL'
#!/bin/sh
set -e
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
	gtk-update-icon-cache -q -f /usr/share/icons/hicolor 2>/dev/null || true
fi
if command -v plymouth-set-default-theme >/dev/null 2>&1 && [ -d /usr/share/plymouth/themes/leptocline ]; then
	plymouth-set-default-theme leptocline 2>/dev/null || true
fi
exit 0
CTL
chmod 0755 "$BASE/DEBIAN/postinst"

dpkg-deb --root-owner-group --build "$BASE" "$OUT/leptocline-base_${VERSION}_all.deb" >/dev/null
echo "built leptocline-base"

# ------------------------------------------------------------- desktop metapkg
# Depends are generated from the shipped package lists, so the metapackage
# always mirrors exactly what the ISO installs.
DESK="$HERE/.stage/leptocline-desktop"
mkdir -p "$DESK/DEBIAN"

DEPS=$(grep -hvE '^\s*#|^\s*$' "$ROOT"/config/package-lists/*.list.chroot \
  | grep -vE '^(linux-image|live-|systemd-sysv)' \
  | sort -u | paste -sd, - | sed 's/,/, /g')

cat > "$DESK/DEBIAN/control" <<CTL
Package: leptocline-desktop
Version: ${VERSION}
Architecture: all
Maintainer: ${MAINT}
Section: metapackages
Priority: optional
Depends: leptocline-base, ${DEPS}
Description: Linux Leptocline desktop — the full toolkit
 Metapackage pulling in the complete Linux Leptocline environment: the Xfce
 desktop, the security toolkit, the development tools and the Java runtime.
 Installing this on a plain Debian trixie turns it into Leptocline.
Homepage: https://github.com/larprober/leptocline
CTL

dpkg-deb --root-owner-group --build "$DESK" "$OUT/leptocline-desktop_${VERSION}_all.deb" >/dev/null
echo "built leptocline-desktop"

rm -rf "$HERE/.stage"
echo
echo "packages in packaging/out:"
ls -1 "$OUT" | sed 's/^/  /'
