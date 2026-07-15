---
name: build-graph
description: Build the project dependency graph a tracker holds — write tasks, milestones, and dependencies through the dispatch graph CLI, and emit the tracker-neutral project-graph document an orchestrator schedules from. Use when asked to build, refresh, or inspect a project graph, or when an orchestrator needs the current frontier or the next task.
---

# build-graph

Produce the §2.6 **project-graph document**, and coordinate who works each task.

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
4. **Write** each item with one command (a bad one fails only itself, never the
   whole sync):

   ```shell
   dispatch graph project set   --id P --name "…"
   dispatch graph milestone set --id M1 --project P --name "M1"
   dispatch graph task set      --id CLC-945 --project P --state "In Progress" \
       [--milestone M1] [--priority 2] [--url U] [--title T] [--labels a,b]
   dispatch graph edge add      --blocker CLC-944 --blocked CLC-945
   ```

5. **Store the cursor** — `dispatch graph cursor --source <tracker> --set <token>`.
6. **Emit** — `dispatch graph doc`. Report any `<anomaly>`; a cycle is illegal
   (§2.3).

## Writing rules

- **Pass native fields.** Give `task set` the tracker's `--state` and `--labels`.
  The CLI derives the role, target-kind, and human-interactive flag — you never
  set those. An unmapped state fails with exit 4 naming the state; add
  it to the config's `states`, or escalate. Never guess a role.
- **Milestones are sequenced with edges, not an order.** `edge add --blocker M1
  --blocked M2` means M2's work waits on M1; a milestone can have several
  predecessors. A task joins a milestone with `task set --milestone M1`.
- **Redeclare a direction with `edge set`.** After re-fetching a task's blockers,
  `edge set --blocked CLC-945 --blockers a,b` makes them exactly `{a,b}` in one
  call (empty clears them). Use it instead of diffing; `edge add`/`edge rm` are
  for single changes.
- **A delta writes only what changed.** A task you don't touch keeps its state.
  Remove one the tracker dropped with `task set`'s absence plus a periodic `reset`
  + full sync, or `task rm` when you know it is gone.

## Reading the result

`dispatch graph doc` — read the derived sections, not the node and edge lists.

| Section         | Means                                                          |
| --------------- | -------------------------------------------------------------- |
| `available`     | Startable now, ranked. `rank="1"` is next.                     |
| `blocked`       | Waiting on `blocked-by` tasks or a `gated-by` milestone.       |
| `human-blocked` | A human must act. Never dispatch an agent at these.            |
| `milestones`    | `ready-for-review` / `review-recorded` — the §2.6 gate.        |
| `counts`        | Per project and milestone; `terminal="true"` means done.       |
| `anomalies`     | Cycles, dangling edges, unknown milestones. Surface these.     |

To just grab work, skip `doc`: `dispatch graph next` prints the top available
task.

## Claiming work

An agent that picks up a task claims it, so no two agents take the same one and a
dead agent's task can be reclaimed (§2.6).

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
