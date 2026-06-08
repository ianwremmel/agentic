#!/usr/bin/env bash
# Build the `dispatch` binary for each release target and stage it into the
# plugin's bin/ directory (committed alongside the plugin, since plugins are
# copied into a cache at install with no build step).
#
# Targets that cannot be built on this host (no cross toolchain) are skipped
# with a warning — so on a Linux box you stage the Linux binaries, on a Mac you
# stage the Darwin ones. CI builds every target to verify the code compiles;
# committing the per-platform binaries is a developer step (see cli/README.md).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_dir="$(cd "$here/.." && pwd)"
repo_root="$(cd "$cli_dir/.." && pwd)"
bin_dir="$repo_root/plugins/dispatch/bin"

targets=(
  x86_64-unknown-linux-gnu
  aarch64-unknown-linux-gnu
  x86_64-apple-darwin
  aarch64-apple-darwin
)
# Override the list with: TARGETS="a b" cli/scripts/build-binaries.sh
if [[ -n "${TARGETS:-}" ]]; then
  read -r -a targets <<<"$TARGETS"
fi

hash="$("$here/source-hash.sh")"
cd "$cli_dir"

for t in "${targets[@]}"; do
  echo ">>> $t" >&2
  if ! rustup target list --installed 2>/dev/null | grep -qx "$t"; then
    rustup target add "$t" >&2 2>/dev/null || true
  fi
  # Apple targets need a Mach-O linker + macOS libc; cargo-zigbuild supplies
  # both (via zig), so we can cross-build them from Linux without the Apple
  # SDK. The Linux targets link with cc / the configured cross-linker.
  build_cmd=(cargo build)
  case "$t" in
    *-apple-darwin)
      if command -v cargo-zigbuild >/dev/null 2>&1; then
        build_cmd=(cargo zigbuild)
      fi
      ;;
  esac
  if ! "${build_cmd[@]}" --release --target "$t" 2>&1 | sed 's/^/    /' >&2; then
    echo "    skipped $t (build failed — cross toolchain missing?)" >&2
    continue
  fi
  src="target/$t/release/dispatch"
  [[ -f "$src" ]] || { echo "    skipped $t (no binary produced)" >&2; continue; }
  dest="$bin_dir/$t"
  mkdir -p "$dest"
  cp "$src" "$dest/dispatch"
  chmod +x "$dest/dispatch"
  printf '%s\n' "$hash" >"$dest/SOURCE_HASH"
  echo "    staged $dest/dispatch" >&2
done
