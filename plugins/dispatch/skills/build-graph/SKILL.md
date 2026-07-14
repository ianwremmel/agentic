---
name: build-graph
description: Build the project dependency graph a tracker holds — fetch tickets, milestones, and dependencies, and emit the tracker-neutral project-graph document an orchestrator schedules from. Use when asked to build, refresh, or inspect a project graph, or when an orchestrator needs the current frontier.
---

# build-graph

Produce the §2.6 **project-graph document**.

**You fetch. The CLI reasons.** Effective blocking, ranking, cycle detection, and
milestone gating are `dispatch graph`'s job. Never derive them yourself; never
hand-edit the graph.

## The loop

1. **Load the augmentation.** Read the `build-<tracker>-graph` skill for the
   tracker (`build-linear-graph` for Linear). It supplies the tools, the field
   mapping, and the cursor. Without one, use the tracker's MCP server directly and
   map its fields onto the payload in [`reference.md`](./reference.md) yourself.
2. **Read the cursor** — `dispatch graph cursor --source <tracker>`. Empty output
   means first run: do a full sync. Otherwise fetch only what changed since it.
3. **Fetch** the selected projects: tickets, milestones, dependency edges. Follow
   dependency edges out of scope until every blocker is fetched; an unfetched
   blocker holds its dependent blocked and surfaces as a `dangling-edge` anomaly.
4. **Normalize** to the payload in [`reference.md`](./reference.md) and ingest it:

   ```bash
   printf '%s' "$payload" | dispatch graph ingest --tracker <tracker> [--full]
   ```

   `--full` rebuilds the graph from scratch — first sync and recovery — dropping
   tickets the tracker no longer returns, and keeping the exclusions and review
   records. A delta merges, and must carry the new cursor.
5. **Emit** the document: `dispatch graph doc`. Report any `<anomaly>`; a cycle is
   illegal (§2.3), never something to work around.

## Rules

- **A delta says what changed.** Send the changed tickets, plus every project and
  milestone they reference (re-sending an unchanged one is free — it upserts). A
  ticket you omit keeps its stored state.
- **`blockedBy` / `blocks` are per-direction, and replace on presence.** Omit the
  direction you did not fetch; sending `[]` there deletes real dependencies. See
  [`reference.md`](./reference.md#edge-semantics).
- **Never invent a role.** Add an unmapped native state to the config's `states`
  map, or escalate — do not guess which role the team meant.
- **Milestones need `sortOrder`** — it decides which milestone gates which.

## Reading the result

Read the derived sections, not the node and edge lists.

| Section               | Means                                                        |
| --------------------- | ------------------------------------------------------------ |
| `available`           | Startable now, ranked. `rank="1"` is next.                   |
| `blocked`             | Waiting on `blocked-by` tickets or a `gated-by` milestone.   |
| `human-blocked`       | A human must act. Never dispatch an agent at these.          |
| `permanently-blocked` | Can never start. Cancelling the failed ancestor releases it. |
| `milestones`          | `ready-for-review` / `review-recorded` — the §2.6 gate.      |
| `counts`              | Per project and milestone; `terminal="true"` means done.     |
| `anomalies`           | Cycles, dangling edges, unknown milestones. Surface these.   |

## Other commands

- `dispatch graph exclude add <id> --kind in-flight|done|failed` — withhold a
  ticket from the frontier (the orchestrator's bookkeeping; the ticket keeps
  syncing). `failed` also permanently blocks everything behind it.
- `dispatch graph record-review <milestone>` — record that the milestone's §2.3
  review ran, which opens its gate. Refuses while the milestone has open work.

Full payload contract, flags, and exit codes: [`reference.md`](./reference.md).
