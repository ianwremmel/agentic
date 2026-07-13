# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

A Claude Code **plugin marketplace**.

The `.claude-plugin/marketplace.json` catalog lists the plugins under
`plugins/`. Each plugin is a self-contained directory with its own
`.claude-plugin/plugin.json` manifest plus the standard `skills/`,
`agents/`, `commands/`, and `hooks/` subdirectories.

## Repo layout

```
.
├── .claude-plugin/marketplace.json   # marketplace catalog
├── plugins/                          # Claude Code plugins
│   └── dispatch/
│       ├── cli/                      # the shared `dispatch` CLI (.mts, no deps)
│       ├── scripts/                  # bash entry points (runtime preflight)
│       └── skills/
├── docs/                             # spec + design docs
└── package.json                      # dev tooling only (eslint, prettier, tsc)
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

## The dispatch CLI

`plugins/dispatch/cli/` is the shared entry point every skill can call for
anything that must be computed identically on every run — today, the project
dependency graph. Skills fetch (over MCP, `gh`, an API); the CLI computes and
stores.

- **Zero runtime dependencies, and it must stay that way.** Plugins are copied
  into an install cache with no `npm install` step. The CLI runs `.mts` directly
  on Node's built-in type stripping and imports only `node:` builtins
  (`sqlite`, `util`, `test`, …). Adding a package to the CLI's import graph
  breaks every install. The root `package.json` is **dev tooling only**.
- **Node 24+.** Type stripping and `node:sqlite` both need a flag below it.
  `scripts/dispatch` enforces this and explains the fix.
- **Errors are read by an agent.** Every failure exits with a stable code
  (2 = bad call, 3 = bad environment, 4 = needs config) and prints a `remedy:`
  line naming the next action. Never fail with a bare stack trace.
- **Logs are logfmt on stderr**; stdout carries command output only.
- **Storage is async by contract.** `node:sqlite` is synchronous, but the store's
  methods are `async` so a future async driver is a change behind the facade
  rather than a rewrite of every caller.

```shell
npm test           # node --test
npm run lint       # eslint: typescript-eslint, @eslint/markdown, prettier
npm run typecheck
```

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

## Do not

- Do not add secrets, tokens, or `.env` files to the repo.
- Do not reference files outside a plugin's directory via `../` — plugins are
  copied into a cache on install and relative paths outside the plugin root
  will not resolve.
