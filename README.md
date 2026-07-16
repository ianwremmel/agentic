# agentic

> A Claude Code plugin marketplace of agentic workflows for everyday software engineering.

This repository is a [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). It packages plugins that extend Claude Code with skills, agents, commands, and hooks tuned for day-to-day engineering work. The current catalog ships a single `dispatch` plugin covering pull request lifecycle management and ticket-tracker project orchestration. Skills, agents, and hooks are being migrated from a prior repo; plugin directories are scaffolded and ready for content to land.

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [Plugins](#plugins)
- [Local Development](#local-development)
- [Contributing](#contributing)
- [License](#license)

## Install

Add the marketplace from inside Claude Code:

```shell
/plugin marketplace add ianwremmel/agentic
```

Or from the CLI:

```shell
claude plugin marketplace add ianwremmel/agentic
```

## Usage

Install the plugin by name, scoped to this marketplace:

```shell
/plugin install dispatch@agentic
```

After installing, reload plugins to pick up the new skills, agents, and commands:

```shell
/reload-plugins
```

## Plugins

| Plugin                         | What it does                                                                                                                                                                                                                                                                           |
| :----------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`dispatch`](plugins/dispatch) | Dispatch engineering work end-to-end: pull request lifecycle (drafting, review, CI triage, merge) and ticket-tracker project orchestration (triage, planning, status, cross-team sync). [Linear.app](https://linear.app) ships bundled; other trackers are added with an adapter file. |

## Local Development

Point Claude Code at a plugin directory without publishing:

```shell
claude --plugin-dir ./plugins/dispatch
```

Validate the marketplace and every plugin manifest:

```shell
claude plugin validate .
```

Plugin code is TypeScript, run unbuilt on Node's native type stripping (Node
24.18+ required). Install the toolchain with `npm install` — which also sets up
the git hooks: lint on commit, commitlint on the message, and on push a
conciseness review (the `skill-reviewer` agent in `.claude/agents/`) of any
skill markdown in the outgoing range — a blocking verdict (a must-fix finding,
or a file judged more than ~25% cuttable) stops the push until acted on
(`SKILL_REVIEW=0` is the emergency bypass). Then:

```shell
npm test            # node:test suites, colocated with the code they cover
npm run lint        # eslint over .mts/.mjs and markdown
npm run lint:fix    # also formats — Prettier runs as an ESLint rule
npm run typecheck
```

Layout:

```text
.
├── .claude-plugin/
│   └── marketplace.json
├── .claude/agents/                # repo-dev subagents (not shipped)
├── .github/workflows/
├── plugins/
│   └── dispatch/
│       ├── .claude-plugin/plugin.json
│       ├── bin/dispatch           # CLI entry point (bash wrapper)
│       ├── cli/                   # CLI sources + colocated tests (.mts)
│       ├── skills/  agents/  commands/  hooks/
└── scripts/                       # repo tooling (git hook bodies)
```

## Contributing

PRs welcome. Work on a feature branch, keep commits clean (no `fixup!` or `#no-push` commits — CI will reject them), and open a pull request against `main`. See [`CLAUDE.md`](CLAUDE.md) for repo conventions when working with Claude Code inside this repo.

## License

[MIT](LICENSE) © Ian Remmel
