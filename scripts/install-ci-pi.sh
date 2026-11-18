#!/usr/bin/env bash

set -euo pipefail

if (( $# != 1 )); then
  printf 'Usage: %s DESTINATION\n' "$0" >&2
  exit 2
fi

version="1.5.2"
sha256="811c6f2c9e7aaee252b5404252e556fb713aa209c1f7f924226aa77d4ef70cb5"
destination=$1
archive="$destination/pi-linux-x64.tar.gz"
url="https://github.com/earendil-works/pi/releases/download/v$version/pi-linux-x64.tar.gz"

mkdir -p "$destination"
curl \
  --fail \
  --location \
  --retry 3 \
  --show-error \
  --silent \
  "$url" \
  --output "$archive"

printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check
tar -xzf "$archive" -C "$destination"
"$destination/pi/pi" --version
