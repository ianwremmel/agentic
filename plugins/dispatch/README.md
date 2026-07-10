# dispatch

> Claude Code plugin for dispatching engineering work across pull requests and dependency-graph-driven projects.

Covers the full lifecycle in four composable tiers, each specified in [`docs/spec`](/docs/spec):

- **`deliver`** (§2.4) — drive one PR to merge: draft, push, CI triage, reviews, iterate, merge.
- **`work-ticket`** (§2.5) — coordinate one tracked work item: fetch its brief, decompose, drive its PR(s) via `deliver`, sync its §2.3 role, verify its aims.
- **`work-project`** (§2.6) — orchestrate one or more whole projects across a merged dependency graph. Each invocation is one stateless tick (refresh the graph, reconcile in-flight units, dispatch a coordinator per unblocked frontier item and a review agent per ready milestone, exit); drive it to completion by running it on an interval with the built-in `/loop`.
- **`build-graph`** (§2.6 producer) — emit the tracker-neutral project-graph document (XML) `work-project` reads. The agent fetches from the tracker (Linear via MCP) and does all graph reasoning — effective-blocking, ranking, cycles, milestone gating — so the orchestrator never re-derives anything.

The skills are agent-driven and work as-is today. Adding deterministic scripting where it's safe — a per-tracker fetch adapter (scriptable for API trackers, MCP-driven for others), a reasoning engine — is a later pass that doesn't change the document contract or the orchestrator. Agents and hooks are still being migrated from a prior repo.

## Install

From inside Claude Code, after adding the `agentic` marketplace:

```shell
/plugin install dispatch@agentic
```

See the [root README](/README.md#install) for marketplace setup.

## Usage

Once installed, the plugin's skills appear under the `dispatch:` namespace. Run `/help` from inside Claude Code to list them.

## Contributing

See the [root README](/README.md#contributing) for branch and commit conventions.

## License

[MIT](/LICENSE) © Ian Remmel
