#!/usr/bin/env bash
# Fetch what a running hub serves and compare it with the hashes published
# for a release (docs/verify.md explains what this proves and what it does
# not).
#
#   scripts/verify-bundle.sh https://your-family.neiliro.com hashes.txt
#
# Every hostname on the service serves the same bundle, so the check can be
# run against any of them — no family has to name itself to verify.
set -euo pipefail

ORIGIN="${1:?usage: verify-bundle.sh <origin> <hashes.txt>}"
LIST="${2:?usage: verify-bundle.sh <origin> <hashes.txt>}"
ORIGIN="${ORIGIN%/}"
[ -f "$LIST" ] || { echo "no such file: $LIST" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 | cut -d' ' -f1; }
else
  echo "need sha256sum or shasum" >&2
  exit 1
fi

failed=0

# $1 is the path inside dist; the page itself is served at "/"
check() {
  path="$1"
  if [ "$path" = "index.html" ]; then url="$ORIGIN/"; else url="$ORIGIN/$path"; fi

  got=$(curl -fsS "$url" | sha) || { echo "FETCH FAILED  $path"; failed=1; return; }
  want=$(awk -v p="$path" '$2 == p { print $1 }' "$LIST")

  if [ -z "$want" ]; then
    echo "NOT IN LIST   $path"
    failed=1
  elif [ "$got" = "$want" ]; then
    echo "OK            $path"
  else
    echo "MISMATCH      $path"
    echo "              served $got"
    echo "              listed $want"
    failed=1
  fi
}

index=$(curl -fsS "$ORIGIN/")
assets=$(printf '%s' "$index" | grep -o "assets/[^\"']*" | LC_ALL=C sort -u || true)
[ -n "$assets" ] || { echo "no assets referenced by $ORIGIN/ — is this a hub?" >&2; exit 1; }

check index.html
for path in $assets; do check "$path"; done
check manifest.webmanifest
check sw.js

# The worker imports its workbox runtime by a hashed name and without the
# extension (its loader appends it); verifying sw.js alone would leave
# executed code unchecked.
workbox=$(curl -fsS "$ORIGIN/sw.js" | grep -oE 'workbox-[0-9a-f]{8}' | LC_ALL=C sort -u || true)
for name in $workbox; do check "$name.js"; done

if [ "$failed" -eq 0 ]; then echo "all files match $LIST"; fi
exit "$failed"
