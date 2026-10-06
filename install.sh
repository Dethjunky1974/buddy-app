#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "Buddy's installer requires macOS 13 or newer."
  exit 1
fi

download_dir="$(mktemp -d "${TMPDIR:-/tmp}/buddy-install.XXXXXX")"
trap 'rm -rf "$download_dir"' EXIT

print "Downloading the latest Buddy release from GitHub…"
/usr/bin/curl --fail --location --silent --show-error --retry 3 \
  https://github.com/Dethjunky1974/buddy-app/archive/refs/heads/main.zip \
  --output "$download_dir/buddy.zip"
/usr/bin/ditto -x -k "$download_dir/buddy.zip" "$download_dir"

zsh "$download_dir/buddy-app-main/scripts/install-macos.sh" "$@"
