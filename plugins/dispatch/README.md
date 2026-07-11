# dispatch

> Claude Code plugin for dispatching engineering work across pull requests and tracked work items.

Covers the full lifecycle: drafting PRs from a working branch, pushing and publishing, CI triage, responding to review comments, and merging — alongside ticket triage, project planning and breakdown, status updates, standups, and keeping tickets in sync with GitHub PRs. Tickets are worked through a tracker adapter; [Linear.app](https://linear.app) ships with the plugin. Skills, agents, and hooks are being migrated from a prior repo — this directory is scaffolding for now.

## Install

From inside Claude Code, after adding the `agentic` marketplace:

```shell
/plugin install dispatch@agentic
```

See the [root README](/README.md#install) for marketplace setup.

## Usage

Once installed, the plugin's skills appear under the `dispatch:` namespace. Run `/help` from inside Claude Code to list them.

## Tracker adapters

`work-ticket` speaks an abstract role vocabulary (`available`, `in-progress`, `in-review`, `delivered`, `verified`, …) and an abstract set of ticket operations. A **tracker adapter** — one markdown file per tracker — maps a platform's native states onto those roles and binds each operation to a concrete tool call. The skill reads nothing else about your tracker, so working tickets on Jira, GitLab, or an in-house tool means writing an adapter, not editing the skill.

For a tracker id `foo`, the first `foo.md` found wins:

1. `.claude/dispatch/trackers/foo.md` in the repo (team-committed)
2. `<tracker_adapters_dir>/foo.md` (defaults to `~/.claude/dispatch/trackers`)
3. the adapters bundled with the plugin (`linear.md`)

Because (1) and (2) shadow (3), the same mechanism customizes the bundled Linear mapping — for instance, to map the custom Backlog substates a team uses for `paused` and `awaiting-external`. Adapters replace rather than merge, so start from a copy of the file you're overriding, or from [`skills/work-ticket/trackers/TEMPLATE.md`](skills/work-ticket/trackers/TEMPLATE.md) for a new tracker; the contract is in [`skills/work-ticket/reference.md`](skills/work-ticket/reference.md#tracker-adapters). A ticket whose tracker has no adapter is an error, never a guess.

## Contributing

See the [root README](/README.md#contributing) for branch and commit conventions.

## License

[MIT](/LICENSE) © Ian Remmel
