# scripts/subcommands/

One file per `orchestrate <name>` subcommand. Each file is sourced (never
executed) by `../orchestrate` and defines a `cmd_<name>` entry function
plus any helpers it needs. Lib dependencies are sourced explicitly at the
top of the file via `$SCRIPTS_DIR/lib/<dep>` (load-guarded, so cheap to
re-source).

## Subcommands

### `check-status`

Aggregates the check-runs / status-checks state for a PR's head SHA
into a single rollup: `merged`, `closed`, `ci_state`, `has_feedback`,
`copilot_clean`, `needs_copilot_request`, `approval_state`, `labels`.

## Tests

Each subcommand has a sibling `<name>.bats` file. The bats `setup()`
sources `./scripts/subcommands/<name>.bash` (which transitively loads its
`lib/` deps) and `./scripts/test-helpers.bash` (which provides the
`retry` override and `_apply_jq_from_args` helper). Tests exercise
`cmd_<name>` directly and any subcommand-local helpers.

## Adding a new subcommand

See `../CLAUDE.md` § "Adding a new subcommand".
