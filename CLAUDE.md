# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

A Claude Code **plugin marketplace**.

The `.claude-plugin/marketplace.json` catalog lists the plugins under
`plugins/`. Each plugin is a self-contained directory with its own
`.claude-plugin/plugin.json` manifest plus the standard `skills/`,
`agents/`, `commands/`, and `hooks/` subdirectories.

## Repo layout

```text
.
├── .claude-plugin/marketplace.json   # marketplace catalog
├── .claude/agents/                   # repo-dev subagents (not shipped)
├── plugins/                          # Claude Code plugins
│   └── dispatch/
│       ├── bin/dispatch              # CLI entry point (bash wrapper)
│       └── cli/                      # CLI sources + colocated tests (.mts)
├── scripts/                          # repo tooling (git hook bodies)
└── docs/                             # spec + design docs
```

Plugins currently published:

- `plugins/dispatch/` — dispatch engineering work across pull requests and
  Linear.app projects (PR lifecycle plus Linear triage, planning, status, and
  cross-team sync)

Skills, agents, and hooks are being migrated from another repo. For now the
subdirectories exist as scaffolding only.

## Repo conventions

- **Plugin layout.** Never put `commands/`, `agents/`, `skills/`, or `hooks/`
  inside `.claude-plugin/`. Only `plugin.json` lives there. All other
  directories go at the plugin root.
- **Naming.** Plugin names, skill folder names, and agent file names are
  kebab-case.
- **Manifest authority.** Each plugin owns its own `plugin.json`. The
  marketplace entry is a pointer; don't duplicate component declarations
  across `marketplace.json` and `plugin.json` unless you explicitly need
  `strict: false`.
- **Versioning.** Bump `version` in the individual plugin's `plugin.json`
  whenever its behavior changes. Semantic versioning.
- **Markdown tables.** Use aligned source-level column widths. Pad every
  cell (and the separator row's dashes) to the max width of its column
  so tables are easy to scan in the raw source. New/edited tables should
  look like:

  ```text
  | Col A | Col B that is longer |
  | ----- | -------------------- |
  | x     | y                    |
  ```
- **Design-doc status.** Design docs under `docs/` have exactly four
  statuses: `draft`, `accepted`, `cancelled`, `obsoleted`. Don't write
  a `Status:` line for `draft` (implied by any unmerged doc) or
  `accepted` (implied by any merged doc). Only `cancelled` and
  `obsoleted` appear explicitly, as a `Status: cancelled` / `Status:
  obsoleted` line under the title, optionally followed by a one-line
  note or link to the superseding doc.

## Adding a new plugin

1. `mkdir -p plugins/<name>/.claude-plugin`
2. Create `plugins/<name>/.claude-plugin/plugin.json` with `name`,
   `description`, `version`, `author`.
3. Add `skills/`, `agents/`, `commands/`, `hooks/` as needed.
4. Register the plugin in `.claude-plugin/marketplace.json` under `plugins[]`
   with `name` and `source: "./plugins/<name>"`.
5. Validate: `claude plugin validate .`
6. Test locally: `claude --plugin-dir ./plugins/<name>`.

## Before starting any work

Run `npm install`. Besides the toolchain, it installs the git hooks (husky):
`pre-commit` runs `lint-staged` (ESLint with `--fix`, which also formats),
`commit-msg` runs commitlint, and `pre-push` runs the `skill-reviewer` agent
(`.claude/agents/skill-reviewer.md`) over any skill markdown changed in the
outgoing range. Only a blocking verdict — a must-fix finding, or a file the
reviewer judges more than ~25% cuttable — blocks the push; act on the report,
commit, and push again. Advisory findings print but never block.
`SKILL_REVIEW=0 git push` is the emergency bypass.
Without that install, the hooks are silently absent and CI catches the mess
instead.

## TypeScript

Plugin code is TypeScript in `.mts` files, run unbuilt on Node's native type
stripping — there is no build step and the CLI has no runtime dependencies.
Consequences worth remembering:

- Import sibling modules by their real path, extension included
  (`./log/logger.mts`).
- Anything a skill invokes at run time lives inside the plugin directory.
- Tests are colocated with the code they cover: `args.mts` → `args.test.mts`.
- Prefer promise-based APIs over callbacks and sync calls, even where sync
  would do — retrofitting async later is the painful refactor. Where a builtin
  is sync-only (`node:sqlite`), wrap it behind an async facade so the call sites
  never have to change.
- `npm run lint`, `npm run typecheck`, `npm test` before pushing; CI runs all
  three. `npm run lint:fix` also formats (Prettier runs as an ESLint rule).

### Standard library first

- Arguments: [`node:util` `parseArgs`](https://nodejs.org/api/util.html#utilparseargsconfig).
- Persistence: [`node:sqlite`](https://nodejs.org/api/sqlite.html).
- Assertions: `node:assert`. Prefer `assert` over `if (…) throw`, and assert
  against a real error — `assert(cond, new DataError(msg, {hint}))` — so the
  failure carries its own remedy.

### Errors are read by an agent

The caller is almost always an agent, not a person at a terminal. Every failure
it can act on is a `DispatchError` (`cli/lib/errors.mts`): a message saying what
happened, a `hint` saying what to do, and an exit code it can branch on —
`2` called wrong, `3` the environment refused (retry), `4` bad data (fix the
payload). Anything else exits `1` with a stack, which means a bug in the CLI.
Write the hint for the agent that has to fix it: name the field, name the fix.

### Files and tests

- Keep files to one job. A module that needs a table of contents is two modules.
- Tests prove behavior, not lines. Each one should fail if a real rule breaks —
  a canceled blocker unblocking its dependents, a stale review re-closing a
  milestone gate. Delete a test that can only fail if the code is deleted.

## Local iteration

- Load a single plugin: `claude --plugin-dir ./plugins/dispatch`
- Reload after edits: `/reload-plugins` (from inside Claude Code)
- Validate the whole marketplace: `claude plugin validate .`
- Run the CLI directly: `./plugins/dispatch/bin/dispatch greet --name World`

## Do not

- Do not add secrets, tokens, or `.env` files to the repo.
- Do not reference files outside a plugin's directory via `../` — plugins are
  copied into a cache on install and relative paths outside the plugin root
  will not resolve.
