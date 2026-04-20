# scripts/lib/

Shared helper functions, sourced (never executed). Each file:

- has no shebang and no `set -euo pipefail` — the caller provides those,
- starts with a load guard (`__LIB_<NAME>_LOADED`) so re-sourcing is a no-op,
- sources its own dependencies via `$SCRIPTS_DIR`, falling back to a
  relative path computed from `BASH_SOURCE[0]`.

## Files

| File             | Purpose                                                                                                        |
|------------------|----------------------------------------------------------------------------------------------------------------|
| `_retry.bash`    | `retry()` — runs a command with exponential backoff. Used everywhere a network call could be flaky.            |
| `gh-auth.bash`   | Identifies who the agent is acting as: `get_gh_user`, `get_authenticated_user`, `is_human_auth`, `wrap_agent_body`. The wrap helper adds the `<!-- agent-reply -->` HTML marker (always) plus a sparkle (✨) block when `is_human_auth` says we're posting under a human's account. |
| `pr-state.bash`  | Reads and mutates PR state: `get_pr_body`, `get_pr_info`, `get_bk_status`, plus the `clc-progress` YAML block helpers (`extract_progress`, `read_progress`, `write_progress`, `update_checklist`). |
| `comments.bash`  | Fetches and enriches PR conversation: `fetch_new_comments`, `fetch_new_issue_comments`, `fetch_parent_comment`, `resolve_thread_context`, `fetch_unreacted_comments`, `compute_max_id`, `fetch_copilot_comments`, `enrich_with_reactions`. The `<!-- agent-reply -->` marker is what filters the agent's own posts out of the feedback loop. |
| `reviews.bash`   | Manages reviews: `fetch_all_reviews`, `compute_approval_state`, `has_copilot_review`, `request_copilot_review`, `has_human_review`, `request_human_review`. |

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
   tests, create `lib/<name>.bats` alongside it. See `_retry.bats` and
   `gh-auth.bats` for the pattern.
