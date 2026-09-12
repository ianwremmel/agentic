# dispatch

> Claude Code plugin for dispatching engineering work across pull requests and tracked work items.

Covers the full lifecycle: drafting PRs from a working branch, pushing and publishing, CI triage, responding to review comments, and merging — alongside driving whole tracker projects under deterministic scheduling. Tickets are worked through a tracker adapter; [Linear.app](https://linear.app) ships with the plugin.

## Install

From inside Claude Code, after adding the `agentic` marketplace:

```shell
/plugin install dispatch@agentic
```

See the [root README](../../README.md#install) for marketplace setup.

## Usage

Once installed, the plugin's skills appear under the `dispatch:` namespace — invoke them as `/dispatch:orchestrate`, or by the bare name (`/orchestrate`) when no other plugin claims it. Run `/help` from inside Claude Code to list them.

## `land` vs `/orchestrate`

`land` drives one pull request to merge, standalone. It takes a PR URL, a
ticket URL, or a plain prompt, resolves that to a brief itself, and re-derives
every decision from `pr-status` each tick. It never decomposes work, walks a
dependency graph, or dispatches anything.

`/orchestrate <project>` drives a whole tracker project. The `dispatch` MCP
server builds the dependency graph through channel-pushed fetch instructions,
then schedules deterministically — ranking, milestone gates, claims — and
pushes work orders the session answers by launching the plugin's
agents: `build-graph` to answer each fetch instruction, `ticket-worker` to
coordinate each ticket, `pr-worker` to implement each PR item (via `land`),
and `milestone-reviewer` per review gate.

Reach for `land` when the unit of work is one PR; `/orchestrate` when it is a
project.

## Tracker adapters

The workers speak an abstract status vocabulary (`available`, `in-progress`, `in-review`, `delivered`, `verified`, …) and an abstract set of ticket operations; `build-graph` sweeps a tracker's projects through the same per-tracker lens. A **tracker adapter** — a skill named `tracker-adapter-<id>` — maps a platform's native states onto those roles, binds each ticket operation to a concrete tool call, and supplies the graph fetch and field mapping. Both skills prefer the adapter and fall back to best-effort use of the tracker's native MCP server when none is installed — an adapter records the state mappings and quirks best effort would have to work out from scratch. Working tickets reliably on Jira, GitLab, or an in-house tool therefore means adding a `tracker-adapter-<id>` skill — in your repo's `.claude/skills/`, personally, or via a plugin — not editing the skills.

The plugin bundles [`tracker-adapter-linear`](skills/tracker-adapter-linear/SKILL.md). A more specific skill with the same tracker id (repo over personal over plugin) shadows it wholesale — adapters replace rather than merge — and the same mechanism customizes the bundled Linear mapping, for instance to map the custom Backlog substates a team uses for `paused` and `awaiting-external`. Start from a copy of the adapter you're replacing — the bundled Linear adapter shows every section an adapter must supply. A tracker that cannot express a required role (`available`, `in-progress`, `verified`, `canceled`) cannot be adapted; the adapter should say so rather than approximate.

## CLI

`bin/dispatch` is the entry point skills shell out to. Claude Code puts a
plugin's `bin/` on `PATH`, so a skill can call it by name:

```shell
dispatch greet --name World      # -> hello World
dispatch --help                  # list commands
```

The CLI holds the project graph in a SQLite store (`node:sqlite`, at
`$DISPATCH_DB`, else `$XDG_STATE_HOME/dispatch/graph-v2.db`) and derives every
scheduling decision from it:

```shell
dispatch ticket set --id CLC-945 --project P --status in-progress   # typed writes
dispatch status                                                     # counts, gates, anomalies, terminal verdict
dispatch queue                                                      # what the scheduler would hand out next
```

Writes go through typed `project`/`milestone`/`ticket`/`edge`/`pr` commands;
effective blocking, ranking, cycle rejection, and milestone gating are computed
in the CLI so every consumer gets the same answer. Workers report with
`outcome set` and open milestone gates with `review record`. `dispatch mcp` runs the same command
surface as an MCP channel server that schedules and pushes work orders;
`mcp ack`/`mcp status` carry the channel handshake. Every command prints its
own flags: `dispatch <command> --help`.

`bin/dispatch` is a bash wrapper around `src/main.mts`. The wrapper checks that
Node is present and at least 24.18 — the CLI ships as unbuilt TypeScript and
relies on Node's native type stripping, so there is no build step.
`DISPATCH_NODE` picks a specific Node binary.

Node refuses to strip types from a file under any `node_modules`, so the CLI
runs only from a plain directory — the plugin install cache, or a checkout —
with its dependencies installed beneath it. Claude Code does that itself:
installing the plugin unpacks it into the cache and runs `npm ci
--ignore-scripts` there, which is why `npm-shrinkwrap.json` ships. Without a
lockfile it skips the install rather than the plugin, so the plugin loads and
every bare import fails at first use instead. Changing `dependencies` therefore
means regenerating the shrinkwrap; `package.test.mts` fails when the two
disagree.

Structured output goes to stdout; error messages go to stderr. A failure
prints an `error:` line and a `hint:` line saying what to do about it, and
exits with a code the caller can branch on: `2` called wrong, `3` the
environment refused (retry), `4` bad data (fix the payload), `1` a bug in the
CLI.

Add a command by writing a file under `src/commands/` — the folder path is the
invocation path, and discovery needs no registry.

## Telemetry

The OpenTelemetry SDK starts with every invocation of the CLI and the server,
configured by the standard `OTEL_*` environment variables. Telemetry is always
on; only the destination changes. Nothing emits spans or metrics yet — this is
the SDK and its exporters, and the instrumentation lands on top of it.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and all three signals go to that collector,
with the rest of the `OTEL_*` environment honored: protocol, headers,
compression, and the per-signal endpoints, each of which overrides the generic
one for its own signal. With no endpoint set, all three are written to
**stderr** instead, one line per record — a signal name and a JSON object:

```text
span {"name":"scheduler.tick","time":"…","trace":"…","kind":"INTERNAL","durationMs":12.4}
```

stderr, not stdout, on every path: `dispatch mcp` owns stdout as its JSON-RPC
channel and the CLI's stdout is the output its caller reads. The SDK's own
diagnostics (`OTEL_LOG_LEVEL`) go to stderr for the same reason, and a signal
whose exporter is set to `console` gets the stderr exporter above rather than
OTel's, whose output would land on stdout. `OTEL_SDK_DISABLED=true` turns the
whole thing off, and `OTEL_SERVICE_NAME` overrides the default `service.name`
of `dispatch`.

If the OTel packages cannot be loaded — an install whose dependencies were
never installed — the CLI prints one `telemetry unavailable:` line to stderr
and runs without telemetry rather than failing.

## Contributing

See the [root README](../../README.md#contributing) for branch and commit conventions.

## License

[MIT](./LICENSE) © Ian Remmel
