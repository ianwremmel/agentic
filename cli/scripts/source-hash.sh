#!/usr/bin/env bash
# Print a deterministic SHA-256 over the CLI's build inputs (Cargo manifests +
# every source file). Used to detect when committed binaries are stale: both
# the local build script and CI compute this and compare it against the
# SOURCE_HASH stored beside each committed binary.
set -euo pipefail
cli_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$cli_dir"
# Sorted, path-inclusive: a rename or content change moves the hash.
find src Cargo.toml Cargo.lock -type f -print0 \
  | LC_ALL=C sort -z \
  | xargs -0 sha256sum \
  | sha256sum \
  | cut -d' ' -f1
