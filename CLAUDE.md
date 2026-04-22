# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

A Claude Code **plugin marketplace**. The `.claude-plugin/marketplace.json`
catalog lists the plugins under `plugins/`. Each plugin is a self-contained
directory with its own `.claude-plugin/plugin.json` manifest plus the standard
`skills/`, `agents/`, `commands/`, and `hooks/` subdirectories (and optionally
`scripts/` for bash automation the plugin shells out to).

Plugins currently published:

- `plugins/dispatch/` — orchestrate agent work across GitHub, CI, and issue
  trackers. Today ships the `scripts/orchestrate` entry point with a single
  `check-status` subcommand; more subcommands land incrementally.

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
