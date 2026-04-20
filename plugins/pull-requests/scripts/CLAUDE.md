# scripts/

Bash automation that backs the `pull-requests` plugin's skills and agents.

## Layout

```
scripts/
├── orchestrate          # Thin entry point. Sources lib/ + subcommands/ and dispatches.
├── orchestrate.bats     # Script-structure + top-level dispatch tests only.
├── test-helpers.bash    # Shared mocks (retry override, _apply_jq_from_args, strict mode) sourced by every .bats.
├── lib/                 # Shared helpers, sourced by subcommands. Idempotent via load guards.
├── subcommands/         # One file per `orchestrate <subcommand>` implementation.
└── buildkite/           # Standalone Buildkite CLI helpers (executed directly, not through orchestrate).
```

## `orchestrate`

Single entry point for everything PR-related. Run `scripts/orchestrate
<subcommand> [args...]`. The script sources every file under `lib/` and
`subcommands/` at startup, then dispatches to the named subcommand. See
`subcommands/CLAUDE.md` for the full subcommand list.

## How the modules fit together

- `lib/*` files only define functions. They have no shebang, no
  `set -euo pipefail`, and a load guard at the top so re-sourcing is a
  no-op. The caller (orchestrate, a subcommand, or a bats test) provides
  the strict-mode flags.
- `subcommands/*` files source the `lib/*` modules they need (transitively
  via the load guards) and define one or more `cmd_<name>` functions.
- `orchestrate` sources every lib + subcommand once at startup, then runs
  the dispatcher. The bottom-of-file guard
  (`if [[ ${BASH_SOURCE[0]} == "${0}" ]]`) means sourcing orchestrate from
  a test does not auto-run `main`.
- `buildkite/*` scripts are standalone CLIs that source `../lib/_retry`
  for the retry helper and otherwise stand alone. They are not wired into
  orchestrate's dispatcher.

## Tests

Tests live alongside the module they cover and source only that module
(plus `scripts/test-helpers.bash` for shared mocks). Run everything from
the plugin root:

```sh
cd plugins/pull-requests
bats scripts/orchestrate.bats \
     scripts/lib/*.bats \
     scripts/subcommands/*.bats \
     scripts/buildkite/*.bats
```

- `scripts/orchestrate.bats` — script-structure checks and top-level
  dispatch (`main` requires a subcommand, rejects unknown ones, routes
  to each `cmd_*`).
- `scripts/lib/*.bats` — unit tests for shared helpers: `_retry.bats`
  (retry behavior) and `gh-auth.bats` (`is_human_auth`, `wrap_agent_body`,
  `get_gh_user`).
- `scripts/subcommands/*.bats` — one file per subcommand, exercising
  `cmd_<name>` plus any helpers used exclusively by that subcommand.
  Tests source the subcommand file, which transitively sources the
  `lib/` modules it depends on (via load guards).
- `scripts/buildkite/*.bats` — the standalone CLI helpers.
- `scripts/test-helpers.bash` — sets strict mode (`set -euo pipefail`),
  overrides `retry` to run commands immediately without sleeping, and
  defines `_apply_jq_from_args` (tests provide `_gh_raw_data` and call
  the helper through a mocked `gh`).

## Adding a new subcommand

1. Create `subcommands/<name>` defining `cmd_<name>` (and any helpers).
   Source the `lib/*` modules it needs.
2. Add `source "$SCRIPTS_DIR/subcommands/<name>"` to `orchestrate`.
3. Add the dispatch case to `orchestrate`'s `main()`.
4. Create `subcommands/<name>.bats` with a `setup()` that sources the
   new subcommand file and `test-helpers.bash`. Cover `cmd_<name>` and
   any subcommand-local helpers.
5. Add a `main dispatches to <name>` test to `orchestrate.bats`
   (alongside the existing dispatch tests).
