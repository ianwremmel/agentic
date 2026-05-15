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

The CLI uses **Node's native TypeScript support** (Node ≥ 22.6 with
`--experimental-strip-types`; ≥ 23.6 has it on by default). There is no
compile step — `.mts` source files are run directly by Node, and
`tsc --noEmit` is used purely for type-checking.

**Source-file conventions:**

- All TypeScript source files use the `.mts` extension (ESM). Do not
  introduce `.ts` or `.cts` files.
- Relative imports between source files include the explicit `.mts`
  extension (`tsconfig.json` sets `allowImportingTsExtensions: true`).
- Type-erasure only: anything that survives type-stripping must be valid
  JS. `tsconfig.json` enforces this with `erasableSyntaxOnly: true` —
  enums, parameter-property shorthand, and namespaces are out; use plain
  `const` objects, explicit assignments, and modules instead.
- Tests use **Node's built-in test runner** (`node:test` + `node:assert/strict`).
  Do not add `vitest`, `jest`, `mocha`, or other third-party runners.

**Commands:**

- Install deps: `npm install`
- Type-check: `npm run typecheck`
- Lint: `npm run lint`
- Format: `npm run format` (check-only: `npm run format:check`)
- Unit tests: `npm test` (runs `npm run bundle` first, then
  `node --test --experimental-strip-types 'src/**/*.test.mts'`)
- Wrapper tests: `npm run test:wrapper` (POSIX-sh test of the
  plugin's `bin/dispatch` shim)
- Bundle only: `npm run bundle` (esbuild is used **only** to produce the
  single CommonJS file that Node 22 SEA requires as `main`; it is not a
  general build step)
- Host-arch SEA binary: `npm run build:host` (writes
  `dist/dispatch-<linux|darwin>-<x64|arm64>`)
- All four SEA binaries: `npm run sea` or `npm run build`

## Cutting a `dispatch` release

The `release-dispatch` workflow (`.github/workflows/release-dispatch.yml`)
publishes binaries and opens a follow-up "bump" PR whenever a
`dispatch-v*` tag is pushed.

1. Pick the new version with `npm`'s helper (it bumps `package.json`,
   creates a commit, and creates a tag):
   ```
   npm version --tag-version-prefix=dispatch-v patch   # or minor/major
   ```
2. Push the tagged commit:
   ```
   git push --follow-tags
   ```
3. The workflow builds all four SEA targets, creates a GitHub Release
   named after the tag with the binaries as assets, and opens a PR
   titled `chore(dispatch): bump bin/VERSION + checksums for
   dispatch-v<version>`. Review and merge that PR to point the
   in-tree wrapper at the new release.

The bump PR is intentionally separate so `plugins/dispatch/bin/`
never points at an unpublished release. The wrapper rejects the
placeholder zero-hash, so an un-released VERSION cannot silently
fetch an unverified binary.

> [!NOTE]
> The release workflow uses the default `GITHUB_TOKEN` for both the
> release upload and the bump PR. This requires the repo setting
> **Settings → Actions → General → Workflow permissions → Allow
> GitHub Actions to create and approve pull requests** to be enabled.

## Do not

- Do not add secrets, tokens, or `.env` files to the repo.
- Do not reference files outside a plugin's directory via `../` — plugins are
  copied into a cache on install and relative paths outside the plugin root
  will not resolve.
