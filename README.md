# agentic

> A Claude Code plugin marketplace of agentic workflows for everyday software engineering.

This repository is a [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). It packages plugins that extend Claude Code with skills, agents, commands, and hooks tuned for day-to-day engineering work. The catalog currently ships one plugin, `dispatch`, which orchestrates agent work across GitHub, CI, and issue trackers.

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

Install any of the plugins by name, scoped to this marketplace:

```shell
/plugin install dispatch@agentic
```

After installing, reload plugins to pick up the new skills, agents, and commands:

```shell
/reload-plugins
```

## Plugins

| Plugin                         | What it does                                                           |
| :----------------------------- | :--------------------------------------------------------------------- |
| [`dispatch`](plugins/dispatch) | Orchestrate agent work across GitHub, CI, and issue trackers.          |

## Local Development

Point Claude Code at a plugin directory without publishing:

```shell
claude --plugin-dir ./plugins/dispatch
```

Validate the marketplace and every plugin manifest:

```shell
claude plugin validate .
```

Layout:

```
.
├── .claude-plugin/
│   └── marketplace.json
├── .github/workflows/
└── plugins/
    └── dispatch/
        ├── .claude-plugin/plugin.json
        └── scripts/   # orchestrate entry point + lib/ + subcommands/
```

## Contributing

PRs welcome. Work on a feature branch, keep commits clean (no `fixup!` or `#no-push` commits — CI will reject them), and open a pull request against `main`. See [`CLAUDE.md`](CLAUDE.md) for repo conventions when working with Claude Code inside this repo.

## License

[MIT](LICENSE) © Ian Remmel
