# dispatch

> Claude Code plugin for dispatching engineering work across pull requests and [Linear.app](https://linear.app) projects.

Covers the full lifecycle at three scopes: a project (`orchestrate`), a ticket (`work-ticket`), and a pull request (`deliver`). Each dispatches the one below it.

## Install

From inside Claude Code, after adding the `agentic` marketplace:

```shell
/plugin install dispatch@agentic
```

See the [root README](/README.md#install) for marketplace setup.

## Usage

Once installed, the plugin's skills appear under the `dispatch:` namespace. Run `/help` from inside Claude Code to list them.

| Skill               | Scope                | Does                                                                                                                  |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `orchestrate`       | one or more projects | Ticks over the dependency graph: dispatches a coordinator per unblocked ticket, gates milestones on review, bounds local compute, runs until every project is terminal. |
| `work-ticket`       | one ticket           | Claims it, fetches its own brief, decomposes if needed, drives its PR(s) via `deliver`, verifies its aims.             |
| `deliver`           | one PR               | Draft PR → CI → review → merge.                                                                                        |
| `build-graph`       | the graph            | Produces the tracker-neutral project-graph document `orchestrate` reads.                                               |
| `graph-fetch-linear`| the graph, on Linear | The Linear adapter behind `build-graph`. Adding a tracker means adding one of these.                                   |
| `review-milestone`  | one milestone        | Judges whether a completed milestone met its goal; files follow-ups; records the outcome.                              |

`orchestrate` needs `max_parallel` (compute slots) and `tracker`; `deliver` needs `operator_login`. See the plugin config for the rest.

## Layout

`bin/` holds the two commands the skills call — `dispatch-state` (run state: the compute-slot ledger, locks, the active set, the injection inbox) and `project-graph` (merge a tracker delta into the cache, derive the document). They are on `PATH` when the plugin is installed, so no skill reaches into another's directory. `project-graph`'s implementation and its tests live in `lib/graph/`; run them with `node --test 'plugins/dispatch/lib/**/*.test.mts'`.

Agents read XML (the project-graph document, a tracker delta, a unit's outcome). The run's internal state — the cache, ledger, locks, active set — is JSON that only those two commands touch.

## Contributing

See the [root README](/README.md#contributing) for branch and commit conventions.

## License

[MIT](/LICENSE) © Ian Remmel
