#!/bin/bash
# Usage: write-build-info.sh <extension-dir> <daemon-binary>
# Records the version (from Cargo.toml) and the daemon's build time in
# <extension-dir>/build-info.json for the About page. The daemon also compares
# this file to decide whether an installed extension is out of date.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -n1)
built=$(date -u -r "$2" +%Y-%m-%dT%H:%M:%SZ)
printf '{"version": "%s", "built": "%s"}\n' "$version" "$built" > "$1/build-info.json"
