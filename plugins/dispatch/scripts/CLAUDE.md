# scripts/

Bash automation that backs the `dispatch` plugin.

## Layout

```
scripts/
├── orchestrate          # Thin entry point. Sources lib/ + subcommands/ and dispatches.
├── orchestrate.bats     # Script-structure + top-level dispatch tests.
├── test-helpers.bash    # Shared mocks (retry override, _apply_jq_from_args, strict mode) sourced by every .bats.
├── lib/                 # Shared helpers, sourced by subcommands. Idempotent via load guards.
└── subcommands/         # One file per `orchestrate <subcommand>` implementation.
```

## `orchestrate`

Single entry point. Run `scripts/orchestrate <subcommand> [args...]`. The
script sources the files under `lib/` and `subcommands/` at startup, then
dispatches to the named subcommand. See `subcommands/CLAUDE.md` for the
current subcommand list.

## How the modules fit together

- `lib/*` files only define functions. They have no shebang, no
  `set -euo pipefail`, and a load guard at the top so re-sourcing is a
  no-op. The caller (orchestrate, a subcommand, or a bats test) provides
  the strict-mode flags.
- Sourced files end in `.bash` so editors give them bash syntax
  highlighting; executed scripts (`orchestrate`) have shebangs and no
  extension.
- `subcommands/*.bash` files source the `lib/*.bash` modules they need
  (transitively via the load guards) and define one or more `cmd_<name>`
  functions.
- `orchestrate` sources every lib + subcommand once at startup, then runs
  the dispatcher. The bottom-of-file guard
  (`if [[ ${BASH_SOURCE[0]} == "${0}" ]]`) means sourcing orchestrate from
  a test does not auto-run `main`.

## Tests

Tests live alongside the module they cover and source only that module
(plus `scripts/test-helpers.bash` for shared mocks). Run everything from
the plugin root:

```sh
cd plugins/dispatch
bats scripts/orchestrate.bats \
     scripts/lib/*.bats \
     scripts/subcommands/*.bats
```

- `scripts/orchestrate.bats` — script-structure checks and top-level
  dispatch (`main` requires a subcommand, rejects unknown ones, routes
  to each `cmd_*`).
- `scripts/lib/*.bats` — unit tests for shared helpers.
- `scripts/subcommands/*.bats` — one file per subcommand, exercising
  `cmd_<name>` plus any helpers used exclusively by that subcommand.
  Tests source the subcommand file, which transitively sources the
  `lib/` modules it depends on (via load guards).
- `scripts/test-helpers.bash` — sets strict mode (`set -euo pipefail`),
  overrides `retry` to run commands immediately without sleeping, and
  defines `_apply_jq_from_args` (tests provide `_gh_raw_data` and call
  the helper through a mocked `gh`).

## Adding a new subcommand

1. Create `subcommands/<name>.bash` defining `cmd_<name>` (and any helpers).
   Source the `lib/*.bash` modules it needs.
2. Add `source "$SCRIPTS_DIR/subcommands/<name>.bash"` to `orchestrate`.
3. Add the dispatch case to `orchestrate`'s `main()`.
4. Create `subcommands/<name>.bats` with a `setup()` that sources the
   new subcommand file and `test-helpers.bash`. Cover `cmd_<name>` and
   any subcommand-local helpers.
5. Add a `main dispatches to <name>` test to `orchestrate.bats`
   (alongside the existing dispatch tests).
