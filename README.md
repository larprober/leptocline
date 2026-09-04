# Linux Leptocline

A Debian-based live distribution. Boots from a USB stick into a themed Xfce
desktop with a network-analysis toolkit already installed, and installs to a
drive from the same image.

```
  release   Linux Leptocline 1.0 "understudy"
  base      Debian 13 (trixie), amd64
  desktop   Xfce 4 + LightDM, Greybird dark, Papirus, JetBrains Mono
  image     iso-hybrid — boots BIOS and UEFI, dd-able to a USB stick
  installer Calamares (graphical), launched from the live desktop
  live user lepto / password live / passwordless sudo / hostname leptocline
  toolkit   ~200 security tools (Debian-native + pinned Kali)
```

## Download & run

Write the ISO to a USB stick (8 GB+) and boot it — it runs entirely off the
stick, touching nothing on your disk until you choose to install.

**Verify your download** (the distributed 1.0 image):

```
sha256  566F6157610BCD9A9DB155346AAABEDD747D89AE5AC1466BF74BFCC890EB2B49
```

```bash
sha256sum leptocline-1.0-amd64.hybrid.iso
```

Match that string and the download is intact and untampered. (A copy you build
yourself will have a different hash — live-build images are not bit-reproducible.)

**Write it to the stick** — this erases the stick:

- Windows: [Rufus](https://rufus.ie) → select the ISO → START → choose **DD Image mode**.
- Linux/macOS: `sudo dd if=leptocline-1.0-amd64.hybrid.iso of=/dev/sdX bs=4M status=progress oflag=sync` (check the device name first).

**Boot it:** reboot, tap the boot-menu key (F9/F12/Esc depending on the maker),
pick the USB, choose **Live system**. Log in as `lepto` / `live` if asked.

> **Two warnings.** The image is unsigned, so you must **disable Secure Boot**
> in firmware to boot it. And do this **only on hardware you own** — never on a
> work or school machine: those often have BitLocker/device encryption, and
> changing Secure Boot triggers a recovery-key lockout only the IT owner can undo.

To install it to a drive, run the **Install Leptocline** icon on the live
desktop (Calamares) — "Guided / use largest free space" installs it alongside an
existing OS.

## Build it

live-build needs a Linux host: it unpacks a Debian chroot, which means real
file ownership, permissions and device nodes. That rules out Windows, macOS,
and any Windows drive mounted into WSL — `build.sh` checks for this and stops
with instructions rather than failing halfway through debootstrap.

On a Debian or Ubuntu machine:

```bash
git clone https://github.com/larprober/leptocline && cd leptocline && ./build.sh
```

From Windows, install a WSL2 distro first, then copy the tree onto its own
filesystem — building from `/mnt/c` will not work:

```bash
wsl --install -d Debian
```

```bash
cp -r /mnt/c/Users/canel/lepto-linux ~/lepto-linux && cd ~/lepto-linux && ./build.sh
```

`build.sh` installs the build dependencies, re-renders the brand assets,
repairs executable bits that Windows and git drop, and runs `lb config` then
`lb build`. Budget 25–50 minutes and ~20 GB of scratch space on the first run;
the result is `lepto-linux-1.0-amd64.iso` in the project root.

```
--clean       purge the previous build tree first
--no-assets   keep the committed PNGs instead of re-rendering
--no-deps     skip apt; assume live-build is already installed
```

Test without a USB stick:

```bash
qemu-system-x86_64 -m 4096 -enable-kvm -cdrom lepto-linux-1.0-amd64.iso
```

## What is in it

| list | holds |
| --- | --- |
| `00-base` | kernel, live-boot, firmware, NetworkManager, filesystem tools |
| `10-desktop` | Xfce, LightDM, themes, fonts, Plymouth, PipeWire |
| `20-netops` | nmap, tcpdump, tshark, mtr, socat, whois, dig, lynis, openssl |
| `30-dev` | git, build-essential, node, python3, ripgrep, tmux, btop |
| `40-apps` | Firefox ESR, Mousepad, Ristretto, disks, calculator |
| `50-security` | 80+ tools: nmap, hydra, hping3, aircrack-ng, sqlmap, john, bettercap, wifite, ffuf, hashcat, thc-ipv6, iodine... |
| `80-kali` | 32 Kali-exclusive tools via the Kali repo (pinned low): nuclei, feroxbuster, bloodhound.py, responder, seclists, certipy, gowitness, beef-xss, zaproxy, searchsploit... Tools that need Kali's Python 3.14 (metasploit, netexec, evil-winrm...) can't install on trixie and are excluded; get Metasploit with `lepto msf`. |

Two commands are the distro's own:

- **`leptofetch`** — the system readout, printed on every new interactive shell.
  Pure bash over `/proc` and `/etc`, no dependencies.
- **`lepto`** — `about`, `tools`, `update`, `install-disk`, `wallpaper`,
  `doctor`. `lepto doctor` verifies the branding and network actually landed,
  which is the fastest way to tell a good build from a silently broken one.

## Brand

`tools/render-assets.js` is the whole visual identity: a zero-dependency Node
script that rasterises its own PNGs (it contains a PNG encoder, a scanline
polygon filler with nonzero/even-odd winding, a 5×7 console face, and a bold
geometric italic built from eight letterforms). The penguin and the wordmark
are defined once as primitives and emitted as **both** the SVG and every PNG,
so they cannot drift apart, and the build host needs no librsvg, Inkscape or
ImageMagick.

```bash
node tools/render-assets.js
```

writes the wallpaper, both boot splashes, and icons at seven sizes into
`branding/out/` and straight into the config tree.

The palette lives in one block near the top of that file. Changing `ACCENT`
re-colours the wallpaper, both splashes, the terminal cursor and the GTK
selection colour in one pass — the terminal and GTK values in
`config/includes.chroot/etc/skel/` are the only copies to update by hand.

## Layout

```
build.sh                        host checks, deps, permissions, lb config, lb build
branding/logo.svg               the mark, generated
branding/logo-lockup.svg        mark + wordmark on ink
tools/render-assets.js          the renderer described above
auto/config                     every live-build switch this image uses
                                (top level — live-build ignores it elsewhere)
config/package-lists/*.chroot   what gets installed
config/preseed/*.cfg.chroot     debconf answers, so the build never blocks
config/hooks/normal/*.chroot    branding, plymouth, session, cleanup
config/includes.chroot/         files copied into the live filesystem
config/includes.binary/         isolinux + grub splash art on the ISO itself
```

## Notes

- The live user has passwordless sudo. That is a deliberate property of a
  throwaway session on read-only media; systems installed to disk get a normal
  password from the installer instead.
- The cleanup hook strips changelogs, apt lists and logs, and blanks
  `/etc/machine-id` so every boot generates a fresh one.
- Debian's `/etc/os-release` is a symlink into `/usr/lib`. The branding hook
  writes both, because tools disagree about which one they read.
- `20-netops` is scanning and packet-capture tooling. Point it at networks you
  are responsible for.
