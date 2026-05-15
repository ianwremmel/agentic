# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

A Claude Code **plugin marketplace** _and_ the source for the `dispatch` CLI.

- The `.claude-plugin/marketplace.json` catalog lists the plugins under
  `plugins/`. Each plugin is a self-contained directory with its own
  `.claude-plugin/plugin.json` manifest plus the standard `skills/`,
  `agents/`, `commands/`, and `hooks/` subdirectories.
- The `dispatch` CLI lives in TypeScript at the repo root (`src/`,
  `package.json`, `tsconfig.json`). It is built into a per-arch Node SEA
  binary and distributed by the `plugins/dispatch/` plugin's shell wrapper.

## Repo layout

```
.
├── .claude-plugin/marketplace.json   # marketplace catalog
├── package.json                      # dispatch CLI manifest (root)
├── tsconfig.json                     # dispatch CLI TS config (root)
├── src/                              # dispatch CLI source
├── plugins/                          # Claude Code plugins
│   └── dispatch/                     # ships the dispatch CLI wrapper
└── docs/                             # spec + design docs
```

The CLI package is `@ianwremmel/dispatch`. The package manager is **npm**;
the committed lockfile is `package-lock.json`.

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

  ```
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

## Local iteration

- Load a single plugin: `claude --plugin-dir ./plugins/dispatch`
- Reload after edits: `/reload-plugins` (from inside Claude Code)
- Validate the whole marketplace: `claude plugin validate .`

## Working on the `dispatch` CLI (root TypeScript project)

- Install deps: `npm install`
- Type-check: `npm run typecheck`
- Lint: `npm run lint`
- Format: `npm run format` (check-only: `npm run format:check`)
- Unit tests: `npm run test` (Vitest)
- Build (bundling lands in #17, SEA pipeline in #18; today this just runs
  `tsc --noEmit`).

## Do not

- Do not add secrets, tokens, or `.env` files to the repo.
- Do not reference files outside a plugin's directory via `../` — plugins are
  copied into a cache on install and relative paths outside the plugin root
  will not resolve.
