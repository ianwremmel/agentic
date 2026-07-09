# dispatch

> Claude Code plugin for dispatching engineering work across pull requests and dependency-graph-driven projects.

Covers the full lifecycle in four composable tiers, each specified in [`docs/spec`](/docs/spec):

- **`deliver`** (§2.4) — drive one PR to merge: draft, push, CI triage, reviews, iterate, merge.
- **`work-ticket`** (§2.5) — coordinate one tracked work item: fetch its brief, decompose, drive its PR(s) via `deliver`, sync its §2.3 role, verify its aims.
- **`work-project`** (§2.6) — orchestrate one or more whole projects across a merged dependency graph: a stateless tick loop that dispatches a coordinator per unblocked frontier item and a review agent per ready milestone, accounts compute slots, and runs to completion.
- **`build-graph`** (§2.6 producer) — emit the tracker-neutral project-graph document `work-project` reads. All graph *reasoning* (effective-blocking, ranking, cycles, milestone gating) is one shared `derive` engine; the *only* tracker-specific step is a per-tracker fetch/normalize **adapter** (`build-graph-<tracker>`), added incrementally against a documented [contract](skills/build-graph/adapters/README.md). No adapter ships yet — the tracker-neutral scaffold is complete and an adapter drops in behind it.

Agents and hooks are still being migrated from a prior repo.

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
