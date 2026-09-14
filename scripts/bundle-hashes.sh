#!/usr/bin/env bash
# SHA-256 of every file the browser can be served out of web/dist, in
# sha256sum format, sorted by path. This is the list published with a
# release, and the list a rebuild from the tag has to reproduce.
#
#   scripts/bundle-hashes.sh [dist-dir] > hashes.txt
#
# Source maps are left out on purpose. They are never executed, so they
# cannot carry an attack, and dist/sw.js.map is not reproducible: workbox
# builds the worker in a temporary directory and the map keeps that path
# plus absolute node_modules paths, which differ on every machine. Hashing
# them would make an honest rebuild disagree with the published list for a
# file nobody runs.
set -euo pipefail

DIST="${1:-web/dist}"
[ -d "$DIST" ] || { echo "no such directory: $DIST" >&2; exit 1; }

# macOS ships shasum, Linux ships sha256sum; the output format is the same
if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$@"; }
else
  echo "need sha256sum or shasum" >&2
  exit 1
fi

# Paths are printed relative to the dist directory, so the list reads the
# way the browser asks for the files (assets/index-Brx0lNSS.js, sw.js).
# LC_ALL=C keeps the sort byte-ordered and independent of the locale.
cd "$DIST"
find . -type f ! -name '*.map' -print |
  sed 's|^\./||' |
  LC_ALL=C sort |
  while IFS= read -r file; do
    sha "$file"
  done
