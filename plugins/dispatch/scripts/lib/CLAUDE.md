# scripts/lib/

Shared helper functions, sourced (never executed). Each file:

- has no shebang and no `set -euo pipefail` — the caller provides those,
- starts with a load guard (`__LIB_<NAME>_LOADED`) so re-sourcing is a no-op,
- sources its own dependencies via `$SCRIPTS_DIR`, falling back to a
  relative path computed from `BASH_SOURCE[0]`.

## Files

### `_retry.bash`

Exports `retry()` — runs a command with exponential backoff. Used
everywhere a network call could be flaky.

## Adding a new lib module

1. Create `lib/<name>.bash` with the standard preamble:
   ```bash
   # lib/<name>.bash - <one-line summary>
   # Sourced; no shebang, no `set -euo pipefail` (the caller provides those).

   [[ -n "${__LIB_<NAME>_LOADED:-}" ]] && return 0
   __LIB_<NAME>_LOADED=1

   SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
   source "$SCRIPTS_DIR/lib/_retry.bash"   # if needed
   ```
2. Add `source "$SCRIPTS_DIR/lib/<name>.bash"` to `../orchestrate` so the
   functions are available to every subcommand.
3. Have any `subcommands/*` module that uses it source it directly too —
   the load guard means there is no double-source cost, and direct
   sourcing keeps the dependency explicit.
4. If the module adds widely-useful behavior that deserves direct unit
   tests, create `lib/<name>.bats` alongside it. See `_retry.bats` for
   the pattern.
