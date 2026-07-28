#!/usr/bin/env bash

set -euo pipefail

if (( $# != 1 )); then
  printf 'Usage: %s DESTINATION\n' "$0" >&2
  exit 2
fi

version="0.82.1"
sha256="884a9dec7e0b75a54c4d1933c93a7d45af1fbb81c32964c1dd45d67fac1f6544"
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
