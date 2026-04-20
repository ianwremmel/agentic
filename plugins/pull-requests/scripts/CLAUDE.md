# scripts/

Bash automation that backs the `pull-requests` plugin's skills and agents.

## Layout

```
scripts/
├── orchestrate          # Thin entry point. Sources lib/ + subcommands/ and dispatches.
├── orchestrate.bats     # Integration tests; sources orchestrate (which loads everything).
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

Run all bats tests from the plugin root:

```sh
cd plugins/pull-requests
bats scripts/orchestrate.bats \
     scripts/lib/*.bats \
     scripts/buildkite/*.bats
```

`scripts/orchestrate.bats` is the integration test: it sources orchestrate
(which loads every module) and exercises the public function surface. The
tests in `lib/_retry.bats` and `buildkite/*.bats` test those modules in
isolation.

## Adding a new subcommand

1. Create `subcommands/<name>` defining `cmd_<name>` (and any helpers).
   Source the `lib/*` modules it needs.
2. Add `source "$SCRIPTS_DIR/subcommands/<name>"` to `orchestrate`.
3. Add the dispatch case to `orchestrate`'s `main()`.
4. Add tests to `orchestrate.bats` under a new `# === <name> subcommand
   tests ===` section, or split them into `subcommands/<name>.bats` if
   the section grows large.
