#!/usr/bin/env bash
# Build a signed APT repository from the Leptocline .deb packages, laid out as a
# flat repo that can be served straight from GitHub Pages (or any static host).
#
# Users then add it with:
#   deb [signed-by=/usr/share/keyrings/leptocline-archive-keyring.gpg] \
#       https://larprober.github.io/leptocline ./
#
# Signing key: set LEPTO_GPG_KEY to an existing key id, or the script generates
# one on first run and exports the public half. KEEP THE PRIVATE KEY SAFE — in
# CI, store it as a secret and import it before running this.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
DEBS="$ROOT/packaging/out"
PUB="$HERE/public"                  # the directory you publish
KEYNAME="Linux Leptocline Archive Key"

command -v gpg >/dev/null      || { echo "need gnupg"; exit 1; }
command -v apt-ftparchive >/dev/null || { echo "need apt-utils (apt-ftparchive)"; exit 1; }
ls "$DEBS"/*.deb >/dev/null 2>&1 || { echo "no .debs in packaging/out — run build-packages.sh first"; exit 1; }

# --- signing key -----------------------------------------------------------
if [ -z "${LEPTO_GPG_KEY:-}" ]; then
	LEPTO_GPG_KEY=$(gpg --list-keys --with-colons "$KEYNAME" 2>/dev/null | awk -F: '/^pub/{print $5; exit}') || true
fi
if [ -z "${LEPTO_GPG_KEY:-}" ]; then
	echo ":: no signing key found — generating one (back up ~/.gnupg after!)"
	cat > /tmp/leptokey <<KEY
%no-protection
Key-Type: eddsa
Key-Curve: ed25519
Key-Usage: sign
Name-Real: ${KEYNAME}
Name-Email: larprober@users.noreply.github.com
Expire-Date: 0
%commit
KEY
	gpg --batch --generate-key /tmp/leptokey
	rm -f /tmp/leptokey
	LEPTO_GPG_KEY=$(gpg --list-keys --with-colons "$KEYNAME" | awk -F: '/^pub/{print $5; exit}')
fi
echo ":: signing with key $LEPTO_GPG_KEY"

# --- assemble the pool + dists --------------------------------------------
rm -rf "$PUB"
mkdir -p "$PUB/pool/main" "$PUB/dists/stable/main/binary-amd64"
cp "$DEBS"/*.deb "$PUB/pool/main/"

cd "$PUB"
apt-ftparchive --arch amd64 packages pool > dists/stable/main/binary-amd64/Packages
gzip -9c dists/stable/main/binary-amd64/Packages > dists/stable/main/binary-amd64/Packages.gz

cat > /tmp/aptrelease.conf <<CFG
APT::FTPArchive::Release::Origin "Leptocline";
APT::FTPArchive::Release::Label "Leptocline";
APT::FTPArchive::Release::Suite "stable";
APT::FTPArchive::Release::Codename "understudy";
APT::FTPArchive::Release::Architectures "amd64";
APT::FTPArchive::Release::Components "main";
APT::FTPArchive::Release::Description "Linux Leptocline package repository";
CFG
apt-ftparchive -c /tmp/aptrelease.conf release dists/stable > dists/stable/Release
rm -f /tmp/aptrelease.conf

# detached + inline signatures
gpg --default-key "$LEPTO_GPG_KEY" --batch --yes -abs \
	-o dists/stable/Release.gpg dists/stable/Release
gpg --default-key "$LEPTO_GPG_KEY" --batch --yes --clearsign \
	-o dists/stable/InRelease dists/stable/Release

# public key users import, in the dearmored form apt wants
gpg --export "$LEPTO_GPG_KEY" > "$PUB/leptocline-archive-keyring.gpg"

echo
echo ":: repo built in repo/public/  (publish this directory)"
echo "   users add it with:"
echo "     sudo curl -fsSLo /usr/share/keyrings/leptocline-archive-keyring.gpg \\"
echo "       https://larprober.github.io/leptocline/leptocline-archive-keyring.gpg"
echo "     echo 'deb [signed-by=/usr/share/keyrings/leptocline-archive-keyring.gpg] \\"
echo "       https://larprober.github.io/leptocline stable main' | \\"
echo "       sudo tee /etc/apt/sources.list.d/leptocline.list"
