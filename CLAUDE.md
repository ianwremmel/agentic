# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

A Claude Code **plugin marketplace**. The `.claude-plugin/marketplace.json`
catalog lists the plugins under `plugins/`. Each plugin is a self-contained
directory with its own `.claude-plugin/plugin.json` manifest plus the standard
`skills/`, `agents/`, `commands/`, and `hooks/` subdirectories.

Plugins currently published:

- `plugins/pull-requests/` — create and monitor pull requests
- `plugins/linear/` — orchestrate projects via Linear.app

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

## Commit hygiene (enforced by CI)

- No `fixup!` commits on pushed branches — squash them first. Enforced by
  [`ianwremmel/prevent-fixup-commits`](https://github.com/ianwremmel/prevent-fixup-commits).
- No commits whose message starts with `#no-push` or `#nopush`. Enforced by
  [`ianwremmel/prevent-nopush-commits`](https://github.com/ianwremmel/prevent-nopush-commits).

If you find one of these in a branch, rebase it out before pushing rather
than bypassing the hook.

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

- Load a single plugin: `claude --plugin-dir ./plugins/pull-requests`
- Reload after edits: `/reload-plugins` (from inside Claude Code)
- Validate the whole marketplace: `claude plugin validate .`

## Do not

- Do not push directly to `main`. Use a feature branch and open a PR.
- Do not add secrets, tokens, or `.env` files to the repo.
- Do not reference files outside a plugin's directory via `../` — plugins are
  copied into a cache on install and relative paths outside the plugin root
  will not resolve.
