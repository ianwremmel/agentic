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

`work-ticket` speaks an abstract role vocabulary (`available`, `in-progress`, `in-review`, `delivered`, `verified`, …) and an abstract set of ticket operations; `build-graph` sweeps a tracker's projects through the same per-tracker lens. A **tracker adapter** — a skill named `tracker-adapter-<id>` — maps a platform's native states onto those roles, binds each ticket operation to a concrete tool call, and supplies the graph fetch and field mapping. Both skills prefer the adapter and fall back to best-effort use of the tracker's native MCP server when none is installed — an adapter records the state mappings and quirks best effort would have to work out from scratch. Working tickets reliably on Jira, GitLab, or an in-house tool therefore means adding a `tracker-adapter-<id>` skill — in your repo's `.claude/skills/`, personally, or via a plugin — not editing the skills.

The plugin bundles [`tracker-adapter-linear`](skills/tracker-adapter-linear/SKILL.md). A more specific skill with the same tracker id (repo over personal over plugin) shadows it wholesale — adapters replace rather than merge — and the same mechanism customizes the bundled Linear mapping, for instance to map the custom Backlog substates a team uses for `paused` and `awaiting-external`. Start from a copy of the adapter you're replacing; the sections an adapter must supply and how each is interpreted are in [`skills/work-ticket/reference.md`](skills/work-ticket/reference.md#tracker-adapters). A tracker that cannot express a required role (`available`, `in-progress`, `verified`, `canceled`) cannot be adapted; the adapter should say so rather than approximate.

## CLI

`bin/dispatch` is the entry point skills shell out to. Claude Code puts a
plugin's `bin/` on `PATH`, so a skill can call it by name:

```shell
dispatch greet --name World      # -> hello World
dispatch --help                  # list commands
```

`dispatch graph` builds, queries, and coordinates work over the project
dependency graph the `build-graph` skill produces — a SQLite-backed store
(`node:sqlite`) plus the derivation an orchestrator schedules from:

```shell
dispatch graph task set --id CLC-945 --project P --role in-progress     # typed writes
dispatch graph doc                                                      # the derived document
dispatch graph next --claim --agent <session-id>                        # grab the next task
```

A skill writes what it fetched through typed `project`/`task`/`edge`/`milestone`
commands; `doc` derives the document and `summary` its scheduling sections.
Effective blocking, ranking, cycle detection, and milestone gating are computed
here rather than by the fetching skill, so every consumer gets the same answer.
`next` and the claim lifecycle (`claim`/`heartbeat`/`release`) coordinate which
agent works which task; `outcome` records each coordinator's final report (and
re-queues follow-up passes), `slot` bounds concurrent local builds, and
`pr add` injects a ticketless PR as a work item. See
[`skills/build-graph/reference.md`](skills/build-graph/reference.md).

`dispatch graph` reads its config from `--config <path>`, else
`$DISPATCH_GRAPH_CONFIG`, else `./.dispatch/graph.json` if it exists. All keys
optional:

```json
{
  "humanInteractiveLabels": ["human-only", "needs-human"],
  "verificationLabels": ["verification"],
  "parkedRoles": ["awaiting-external", "paused"],
  "claimStaleAfter": "10m",
  "maxParallel": 3
}
```

The label lists derive a task's target-kind and human-interactive flag;
`maxParallel` sizes the compute-slot ledger (`dispatch graph slot`).

It is a bash wrapper around `cli/main.mts`. The wrapper checks that Node is
present and at least 24.18 — the CLI ships as unbuilt TypeScript and relies on
Node's native type stripping, so there is no build step and no runtime
dependencies. `DISPATCH_NODE` picks a specific Node binary.

Structured output goes to stdout; logfmt records and error messages go to
stderr. `--log-level debug|info|warn|error` (or `DISPATCH_LOG_LEVEL`) sets
verbosity; the default is `info`.

A failure prints an `error:` line and a `hint:` line saying what to do about it,
and exits with a code the caller can branch on: `2` called wrong, `3` the
environment refused (retry), `4` bad data (fix the payload), `1` a bug in the
CLI.

Add a command by writing it in `cli/commands/` and listing it in
`cli/lib/registry.mts`.

## Contributing

See the [root README](/README.md#contributing) for branch and commit conventions.

## License

[MIT](/LICENSE) © Ian Remmel
