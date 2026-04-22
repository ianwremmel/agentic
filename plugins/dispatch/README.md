# dispatch

> Claude Code plugin for orchestrating agent work across GitHub, CI, and issue trackers.

A thin dispatcher (`scripts/orchestrate`) plus a growing library of subcommands that read and mutate the state of a pull request's ecosystem — its reviews, CI checks, labels, and (eventually) its issue-tracker counterpart. Built to be host-agnostic: today it talks to GitHub and reads Buildkite via the GitHub statuses API; future subcommands will extend to other CI systems and trackers.

## Install

From inside Claude Code, after adding the `agentic` marketplace:

```shell
/plugin install dispatch@agentic
```

See the [root README](../../README.md#install) for marketplace setup.

## Usage

Currently the plugin ships one subcommand:

```shell
scripts/orchestrate check-status <pr_number>
```

Aggregates a PR's state into a single JSON rollup: `merged`, `closed`, `ci_state`, `has_feedback`, `copilot_clean`, `needs_copilot_request`, `approval_state`, and `labels`. Requires `gh` (GitHub CLI) authenticated for the target repo and `jq`.

## Contributing

See the [root README](../../README.md#contributing) for branch and commit conventions. See `scripts/CLAUDE.md` for the dispatcher layout and how to add a new subcommand.

## License

[MIT](../../LICENSE) © Ian Remmel
