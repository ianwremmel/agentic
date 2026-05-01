# scripts/subcommands/

One file per `orchestrate <name>` subcommand. Each file is sourced (never
executed) by `../orchestrate` and defines a `cmd_<name>` entry function
plus any helpers it needs. Lib dependencies are sourced explicitly at the
top of the file via `$SCRIPTS_DIR/lib/<dep>` (load-guarded, so cheap to
re-source).

## Subcommands

### `ready`

Marks a draft PR as ready for review.

### `reply`

Posts an agent reply to a PR — `--inline <pr> <comment_id> <body>` for
review-comment threads, `--issue <pr> <body>` for top-level PR
comments. Bodies are wrapped via `wrap_agent_body` (HTML marker
always; sparkles when human-authenticated).

### `progress`

Reads and updates the `clc-progress` YAML block embedded in the PR
body. Used to track agent phase, CI fix attempts, watermarks for new
comments/reviews, etc.

### `setup`

Prepares a worktree by fetching `origin/main` and rebasing. Reports
rebase conflicts as JSON.

### `find-worktree`

Auto-detects an identifier (PR number, ticket ID, branch name) and
either finds the existing worktree for it or reports where to create
one. Honors `WORKTREE_BASE` env override.

### `react`

Applies an emoji reaction (`+1`, `eyes`, `rocket`, etc.) to an inline
review comment or an issue comment via the GitHub API.

### `label`

Adds or removes a label on a PR. Auto-creates the `agent-working` and
`needs-followup` labels with predefined colors if they don't exist.

### `start-pr`

Creates a new PR from the current branch — derives a title from the
branch name, generates a body (with the `clc-progress` block), and
registers the PR in `ACTIVE_PRS_FILE`. Honors `ACTIVE_PRS_DIR` /
`ACTIVE_PRS_FILE` env overrides.

### `poll`

One-shot poll of a PR. Returns CI state, mergeability, new reviews,
new inline/issue comments past the watermarks, approval state, and
(with `--include-unreacted`) older comments lacking an agent
reaction. Resolves parent comments for any reply.

### `review`

- `review copilot [--force] <pr>` requests a Copilot review, rotating
  in `GH_REVIEW_REQUEST_TOKEN` when the current auth isn't a human.
- `review human <reviewer> <pr>` requests a review from the given
  reviewer; skips when the agent is authenticated as that reviewer.

### `check-status`

Aggregates the check-runs / status-checks state for a PR's head SHA
into a single rollup.

### `debug`

Dumps a complete debug snapshot of a PR: state, progress block,
worktree info, status files, lock files. Handy for incident triage.

## Tests

Each subcommand has a sibling `<name>.bats` file. The bats `setup()`
sources `./scripts/subcommands/<name>.bash` (which transitively loads its
`lib/` deps) and `./scripts/test-helpers.bash` (which provides the
`retry` override and `_apply_jq_from_args` helper). Tests exercise
`cmd_<name>` directly and any subcommand-local helpers.

## Adding a new subcommand

See `../CLAUDE.md` § "Adding a new subcommand".
