# dispatch

> Claude Code plugin for dispatching engineering work across pull requests and [Linear.app](https://linear.app) projects.

Covers the full lifecycle: drafting PRs from a working branch, pushing and publishing, CI triage, responding to review comments, and merging — alongside Linear issue triage, project planning and breakdown, status updates, standups, and keeping Linear issues in sync with GitHub PRs. Skills, agents, and hooks are being migrated from a prior repo — this directory is scaffolding for now.

## Install

From inside Claude Code, after adding the `agentic` marketplace:

```shell
/plugin install dispatch@agentic
```

See the [root README](/README.md#install) for marketplace setup.

## Usage

Once installed, the plugin's skills appear under the `dispatch:` namespace. Run `/help` from inside Claude Code to list them.

| Skill                                                | What it does                                                                                                                        |
| :--------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| [`deliver`](skills/deliver)                          | Drive one code change to merge through a draft PR — CI, reviews, iteration, until close.                                            |
| [`work-ticket`](skills/work-ticket)                  | Coordinate one tracked work item end-to-end: claim it, decompose it, drive its PR(s) via `deliver`, verify its aims.                |
| [`build-graph`](skills/build-graph)                  | Build the tracker-neutral project dependency graph: the ranked available frontier, blocked and human-blocked sets, milestone gates. |
| [`build-linear-graph`](skills/build-linear-graph)    | The Linear adapter for `build-graph` — MCP tools, field names, status→role mapping, and the `updatedAt` cursor.                     |

## Requirements

`build-graph` stores the graph in SQLite via the shared `dispatch` CLI, which
needs **Node 24 or newer** on `PATH`. There is nothing to install: the CLI has no
dependencies and runs TypeScript directly. `scripts/dispatch` checks the runtime
and reports what to fix if it is missing or too old.

`deliver`'s `pr-status` script needs `gh` and `jq`.

## Configuration

Set these in the plugin's config (`/plugin` → dispatch). `operator_login` is
required; the rest have defaults.

| Option                | Used by                | Meaning                                                     |
| :-------------------- | :--------------------- | :---------------------------------------------------------- |
| `operator_login`      | `deliver`              | GitHub login of the operator directing the agent.           |
| `team_mode`           | `deliver`              | Adds a private operator review stage before public review.  |
| `copilot_available`   | `deliver`              | Whether Copilot review works on this install.               |
| `worktree_base`       | `deliver`              | Root for per-PR worktrees.                                  |
| `tracker`             | `work-ticket`          | Default work-item tracker.                                  |
| `graph_db`            | `build-graph`          | Where the project graph is stored.                          |
| `graph_config`        | `build-graph`          | Team overrides: custom statuses, label names.               |

## Contributing

See the [root README](/README.md#contributing) for branch and commit conventions.

## License

[MIT](/LICENSE) © Ian Remmel
