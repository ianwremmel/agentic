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
│   ├── dispatch/
│   │   ├── bin/dispatch              # CLI entry point (bash wrapper)
│   │   └── cli/                      # CLI sources + colocated tests (.mts)
│   └── land/
│       └── bin/pr-status             # PR state snapshot (bash)
├── scripts/                          # repo tooling (git hook bodies)
└── docs/                             # spec + design docs
```

Plugins currently published:

- `plugins/dispatch/` — dispatch engineering work across pull requests and
  tracked work items (PR lifecycle plus ticket triage, planning, status, and
  cross-team sync). Trackers are pluggable: `work-ticket` and `build-graph`
  load a per-tracker adapter skill (`tracker-adapter-<id>`) rather than
  hardcoding one; `tracker-adapter-linear` ships bundled.
- `plugins/land/` — one skill (`deliver`) plus `bin/pr-status`: take a single
  PR to completion, started from a PR URL, a ticket URL, or a prompt. Stateless
  — no CLI, no database. Its `deliver` skill is a copy of the one in
  `dispatch`; the two are meant to converge on one source later, so a change to
  either usually belongs in both.

Skills, agents, and hooks are being migrated from another repo. For now the
subdirectories exist as scaffolding only.

## Repo conventions

- **Plugin layout.** Never put `commands/`, `agents/`, `skills/`, or `hooks/`
  inside `.claude-plugin/`. Only `plugin.json` lives there. All other
  directories go at the plugin root.
- **Determinism lives in the CLI.** If a step has one correct output for a
  given input (e.g. slot and ledger bookkeeping, gate evaluation, parsing,
  formatting), implement it in the plugin's CLI and have the skill call it.
  Skill markdown is for judgment and orchestration. The exception is a hard
  runtime constraint: MCP tools exist only in the skill's agent session, so
  MCP access stays in the skill.
- **Naming.** Plugin names, skill folder names, and agent file names are
  kebab-case.
- **No spec references in agent-facing text.** The `docs/spec/` tree is not
  bundled with the plugin, so a `§2.6`-style citation in a `SKILL.md`, a skill
  `reference.md`, or a CLI error/output string points at nothing for the invoking
  agent. State the rule itself instead. Spec citations are fine in code comments
  and design docs, which are read against this repo.
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
- Assertions: `node:assert` for invariants. When the failure is a taxonomy
  error, use the function form — `ensure(cond, () => new DataError(msg,
  {hint}))` from `cli/lib/errors.mts` — so the failure carries its own remedy
  and the error is only constructed when the assertion fails.

### Errors are read by an agent

The caller is usually an agent, so a failure it can act on is a `DispatchError`
(`cli/lib/errors.mts`) carrying a `hint` and an exit code to branch on. That file
is the source of truth for the taxonomy and the codes — the classes enforce it,
so read it there. When you add one, write the hint for the agent that has to fix
the failure: name the field, name the fix.

### Files

Keep each file to one job; split a module once it has grown a table of contents.

### Tests

Write each test to fail when a specific rule breaks: that a canceled blocker
unblocks its dependents, that a stale review re-opens a milestone gate. A test
that can only fail when the code is deleted asserts nothing about behavior —
delete it.

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
