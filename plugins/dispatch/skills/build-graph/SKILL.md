---
name: build-graph
description: Build the project dependency graph a tracker holds — write tasks, milestones, and dependencies through the dispatch graph CLI, and emit the tracker-neutral project-graph document an orchestrator schedules from. Use when asked to build, refresh, or inspect a project graph, or when an orchestrator needs the current frontier or the next task.
---

# build-graph

Produce the **project-graph document**, and coordinate who works each task.

**You fetch. The CLI reasons.** Effective blocking, ranking, cycle detection, and
milestone gating are `dispatch graph`'s job. Never derive them yourself; never
hand-edit the graph.

## The loop

1. **Load the augmentation.** Read the `build-<tracker>-graph` skill for the
   tracker (`build-linear-graph` for Linear) — it supplies the tools, the field
   mapping, and the cursor. Without one, drive the tracker's MCP server directly
   and map its fields onto the flags below yourself.
2. **Read the cursor** — `dispatch graph cursor --source <tracker>`. Empty output
   means first run: `dispatch graph reset`, then a full sync. Otherwise fetch only
   what changed since it.
3. **Fetch** the selected projects: tasks, milestones, dependencies.
4. **Write** each item with one command (a bad one fails only itself):

   ```shell
   dispatch graph project set   --id P --name "…"
   dispatch graph milestone set --id M1 --project P --name "M1"
   dispatch graph task set      --id CLC-945 --project P --role in-progress \
       [--milestone M1] [--priority 2] [--url U] [--title T] [--labels a,b]
   dispatch graph edge add      --blocker CLC-944 --blocked CLC-945
   ```

5. **Store the cursor** — `dispatch graph cursor --source <tracker> --set <token>`.
6. **Emit** — `dispatch graph doc`. Report any `<anomaly>` it carries.

## Writing rules

- **You map the state; the CLI knows only the protocol.** `--role` takes a
  normalized role (`backlog`, `paused`, `awaiting-external`, `available`,
  `in-progress`, `in-review`, `finished`, `delivered`, `verified`, `canceled`).
  The augmentation skill carries the tracker's state→role table; a state it does
  not cover is escalated to the operator. Never guess a role. Labels pass
  through natively — the CLI derives target-kind and human-interactive from
  `--labels` plus config.
- **Milestones are sequenced with edges, not an order.** `edge add --blocker M1
  --blocked M2` means M2's work waits on M1; a milestone can have several
  predecessors. A task joins a milestone with `task set --milestone M1`.
- **Redeclare a direction with `edge set`.** After re-fetching a task's blockers,
  `edge set --blocked CLC-945 --blockers a,b` makes them exactly `{a,b}` in one
  call (empty clears them). Use it instead of diffing; `edge add`/`edge rm` are
  for single changes.
- **An edge that would close a cycle is refused** (exit 4). Fix the direction, or
  remove the opposing edge first.
- **A delta writes only what changed.** A task you don't touch keeps its state.
  Drop one the tracker removed with `task rm`, or let a periodic `reset` + full
  sync prune it.

## Emitting and grabbing work

`dispatch graph doc` emits the full project-graph document — every task and its
state, the ranked frontier, milestone gates, counts, and anomalies. It is the
orchestrator's view; report any anomaly, since a cycle or dangling edge is a data
problem, not a schedule.

An agent that just needs the next thing to work skips `doc`:
`dispatch graph next` prints the top available task as a `<ticket>` element, or
nothing when the frontier is empty.

## Claiming work

Picking up a task claims it, so two agents can't take the same one and a dead
agent's task can be reclaimed.

```shell
dispatch graph next --claim --agent <session-id>   # grab + claim the top task atomically
dispatch graph heartbeat --id CLC-945 --agent <session-id>   # keep it alive while working
dispatch graph release   --id CLC-945 --agent <session-id>   # give it back when done
```

- **A claim expires** if not heartbeated within the staleness window (config
  `claimStaleAfter`, or `--stale-after`). Another agent's `claim` then reclaims it.
  `claim`/`heartbeat` fail non-zero once you no longer hold it — stop and re-acquire.
- **Finishing a task**, in order: advance it in the tracker → re-`task set` it with
  its new state → `release`. Releasing after the graph shows it done keeps it from
  reappearing on the frontier.
- **A task that can't be done** is canceled in the tracker (→ role `canceled`),
  which settles it and unblocks its dependents. There is no "failed" state.
- **A milestone review** that has run: `dispatch graph record-review --id M1`. It
  opens the gate, and refuses while the milestone has open work.

Full flags and exit codes: [`reference.md`](./reference.md).
