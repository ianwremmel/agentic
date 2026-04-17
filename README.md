# agentic

A Claude Code plugin marketplace of agentic workflows for day-to-day software
engineering.

## Plugins

| Plugin                                   | What it does                                                                                        |
| :--------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| [`pull-requests`](plugins/pull-requests) | Create and monitor pull requests end-to-end: drafting, review, CI triage, and merge.                |
| [`linear`](plugins/linear)               | Orchestrate projects via [Linear.app](https://linear.app): triage, planning, status, cross-team sync. |

Skills, agents, and hooks are being migrated from a prior repo. The directories
are scaffolded but empty for now.

## Install

Add this marketplace from Claude Code:

```shell
/plugin marketplace add ianwremmel/agentic
```

Then install the plugins you want:

```shell
/plugin install pull-requests@agentic
/plugin install linear@agentic
```

## Layout

```
.
├── .claude-plugin/
│   └── marketplace.json         # Marketplace catalog
├── .github/
│   └── workflows/               # CI: commit validation, plugin validation
└── plugins/
    ├── pull-requests/
    │   ├── .claude-plugin/plugin.json
    │   ├── skills/
    │   ├── agents/
    │   ├── commands/
    │   └── hooks/
    └── linear/
        ├── .claude-plugin/plugin.json
        ├── skills/
        ├── agents/
        ├── commands/
        └── hooks/
```

## Local development

Point Claude Code at a plugin directory without publishing:

```shell
claude --plugin-dir ./plugins/pull-requests
claude --plugin-dir ./plugins/linear
```

Validate the marketplace:

```shell
claude plugin validate .
```

## Commit hygiene

CI rejects `fixup!` commits and commits tagged `#no-push` / `#nopush`:

- [`ianwremmel/prevent-fixup-commits`](https://github.com/ianwremmel/prevent-fixup-commits)
- [`ianwremmel/prevent-nopush-commits`](https://github.com/ianwremmel/prevent-nopush-commits)

Squash or rebase before pushing.

## License

MIT
