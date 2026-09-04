# Linux Leptocline

A Debian based live distribution. It boots from a USB stick into a themed Xfce
desktop with a security toolkit already installed, and installs to a drive from
the same image.

```
  release   Linux Leptocline 1.0 "understudy"
  base      Debian 13 (trixie), amd64
  desktop   Xfce 4 + LightDM, Greybird dark, Papirus, JetBrains Mono
  image     iso-hybrid, boots BIOS and UEFI, dd-able to a USB stick
  installer Calamares (graphical), launched from the live desktop
  live user lepto / password live / passwordless sudo / hostname leptocline
  toolkit   ~200 security tools (Debian native plus a pinned Kali set)
```

## Get it

Grab the latest build from the
[Releases page](https://github.com/larprober/leptocline/releases). The ISO is
about 3.8 GB, over GitHub's 2 GB per file limit, so it ships as three parts.
Download all three (`.001`, `.002`, `.003`) plus `SHA256SUMS.txt`, then rejoin
them:

```bash
# Linux / macOS
cat leptocline-1.0-amd64.hybrid.iso.* > leptocline-1.0-amd64.hybrid.iso
```

```
:: Windows (cmd)
copy /b leptocline-1.0-amd64.hybrid.iso.001 + leptocline-1.0-amd64.hybrid.iso.002 + leptocline-1.0-amd64.hybrid.iso.003 leptocline-1.0-amd64.hybrid.iso
```

Verify it with `sha256sum -c SHA256SUMS.txt`. The expected ISO hash is
`566f6157610bcd9a9db155346aaabedd747d89ae5ac1466bf74bfcc890eb2b49`. A copy you
build yourself will hash differently, because live-build images are not bit
reproducible.

## Run it

Write the rejoined ISO to a USB stick (8 GB or larger). This erases the stick.

- Windows: [Rufus](https://rufus.ie), select the ISO, press START, choose **DD Image mode**.
- Linux/macOS: `sudo dd if=leptocline-1.0-amd64.hybrid.iso of=/dev/sdX bs=4M status=progress oflag=sync` (check the device name first).

Boot it: reboot, tap the boot menu key (F9, F12, or Esc depending on the maker),
pick the USB, choose **Live system**. Log in as `lepto` / `live` if asked. It
runs entirely off the stick and RAM, touching nothing on your disk until you
choose to install.

> **Two warnings.** The image is unsigned, so you must **disable Secure Boot**
> in firmware to boot it. And do this **only on hardware you own**, never on a
> work or school machine: those often have BitLocker or device encryption, and
> changing Secure Boot triggers a recovery key lockout only the IT owner can undo.

To install it to a drive, run the **Install Leptocline** icon on the live
desktop (Calamares). The "Guided, use largest free space" option installs it
alongside an existing OS.

## Build it

live-build needs a Linux host: it unpacks a Debian chroot, which means real
file ownership, permissions and device nodes. That rules out Windows, macOS, and
any Windows drive mounted into WSL. `build.sh` checks for this and stops with
instructions rather than failing halfway through debootstrap.

On a Debian or Ubuntu machine:

```bash
git clone https://github.com/larprober/leptocline && cd leptocline && ./build.sh
```

From Windows, install a WSL2 distro first, then copy the clone onto the WSL
filesystem (building from `/mnt/c` will not work):

```bash
wsl --install -d Debian
```

```bash
cp -r /mnt/c/path/to/leptocline ~/leptocline && cd ~/leptocline && ./build.sh
```

`build.sh` installs the build dependencies, re-renders the brand assets, repairs
executable bits that Windows and git drop, and runs `lb config` then `lb build`.
Budget 25 to 50 minutes and about 20 GB of scratch space on the first run. The
result is `leptocline-1.0-amd64.hybrid.iso` in the project root.

```
--clean       purge the previous build tree first
--rebuild     discard the chroot, keep the package cache
--fast        reuse the chroot, only repack (skips chroot hooks)
--no-assets   keep the committed PNGs instead of re-rendering
--no-deps     skip apt; assume live-build is already installed
```

Test without a USB stick:

```bash
qemu-system-x86_64 -m 4096 -enable-kvm -cdrom leptocline-1.0-amd64.hybrid.iso
```

## What is in it

| list | holds |
| --- | --- |
| `00-base` | kernel, live-boot, firmware, NetworkManager, filesystem tools |
| `10-desktop` | Xfce, LightDM, themes, fonts, Plymouth, PipeWire, brightnessctl |
| `20-netops` | nmap, tcpdump, tshark, mtr, socat, whois, dig, lynis, openssl |
| `30-dev` | git, build-essential, node, python3, ripgrep, tmux, btop |
| `40-apps` | Firefox ESR, Mousepad, Ristretto, disks, calculator |
| `50-security` | 168 tools: nmap, hydra, hashcat, aircrack-ng, sqlmap, bettercap, wifite, ffuf, sleuthkit, gnuradio, ubertooth, yara, and more |
| `60-java` | OpenJDK 21 and Prism Launcher (Minecraft) |
| `80-kali` | 32 Kali exclusive tools via the pinned Kali repo: nuclei, feroxbuster, bloodhound.py, responder, seclists, certipy, beef-xss, zaproxy, searchsploit, and more. Tools that need Kali's Python 3.14 (metasploit, netexec, evil-winrm) cannot install on trixie and are left out; get Metasploit with `lepto msf`. |

Two commands are the distro's own:

- **`leptofetch`**: the system readout, printed on every new interactive shell.
  Pure bash over `/proc` and `/etc`, no dependencies.
- **`lepto`**: `about`, `tools`, `update`, `install-disk`, `wallpaper`,
  `doctor`, `msf`. `lepto doctor` verifies the branding and network actually
  landed, the fastest way to tell a good build from a silently broken one.

## Brand

`tools/render-assets.js` is the whole visual identity: a zero-dependency Node
script that rasterises its own PNGs. It contains a PNG encoder, a scanline
polygon filler with nonzero and even-odd winding, a 5x7 console face, and a bold
geometric italic built from eight letterforms. The penguin and the wordmark are
defined once as primitives and emitted as **both** the SVG and every PNG, so
they cannot drift apart, and the build host needs no librsvg, Inkscape or
ImageMagick.

```bash
node tools/render-assets.js
```

It writes the wallpaper, both boot splashes, icons at seven sizes, and the
terminal logo into `branding/out/` and straight into the config tree.

The palette lives in one block near the top of that file. Changing `ACCENT`
re-colours the wallpaper, both splashes, the terminal cursor and the GTK
selection colour in one pass. The terminal and GTK values in
`config/includes.chroot/etc/skel/` are the only copies to update by hand.

## Layout

```
build.sh                        host checks, deps, permissions, lb config, lb build
auto/config                     every live-build switch this image uses (top level)
branding/logo.svg               the mark, generated
tools/render-assets.js          the renderer described above
packaging/build-packages.sh     builds the leptocline-base and -desktop packages
config/archives/                the pinned Kali repo, its key and preferences
config/package-lists/*.chroot   what gets installed
config/preseed/*.cfg.chroot     debconf answers, so the build never blocks
config/hooks/normal/*.chroot    branding, plymouth, session, prism, calamares, cleanup
config/includes.chroot/         files copied into the live filesystem
config/includes.binary/         isolinux and grub splash art on the ISO itself
```

## Notes

- The live user has passwordless sudo. That is a deliberate property of a
  throwaway session on read-only media; systems installed to disk get a normal
  password instead.
- The Kali repo is pinned at priority 100, below Debian, so the Debian base
  stays preferred and only the named Kali tools (and their required
  dependencies) come from Kali.
- The security tooling is for scanning, exploitation and packet capture. Point
  it only at systems you own or are authorised to test.
