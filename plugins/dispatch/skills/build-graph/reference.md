# build-graph — reference

Shapes and lookups for [`SKILL.md`](./SKILL.md).

## Normalized input

The delta (or full sync) handed to `scripts/graph merge`. One tracker only.

```json
{
  "full": false,
  "cursor": "2026-07-11T18:04:00Z",
  "projects":   [{ "id": "proj-api", "name": "API v2" }],
  "milestones": [{ "id": "m1", "project": "proj-api", "name": "Schema", "order": 1,
                   "review_recorded": false }],
  "nodes":      [{ "id": "DEV-12", "url": "https://…", "role": "available",
                   "group": "unstarted", "project": "proj-api", "milestone": "m1",
                   "target_kind": "pr", "human_interactive": false, "dead": false,
                   "priority": 100, "labels": ["needs-human"], "branch_hint": "dev-12-schema" }],
  "edges":      [{ "blocker": "DEV-11", "blocked": "DEV-12" }],
  "edges_for":  ["DEV-12"]
}
```

| field               | notes                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `full`              | `true` ⇒ the cache is replaced wholesale. A delta omits it.                                          |
| `order`             | milestone sequence within its project. Drives the review gate and ranking.                           |
| `review_recorded`   | a review recorded **since the milestone last gained a ticket**. Scoped to the current ready-for-review episode: if a review files follow-ups into the milestone, the newest ticket is younger than the review, so this goes back to `false` and the re-review runs. A monotone "was ever reviewed" flag would skip it. |
| `role` / `group`    | the protocol's vocabulary, never the tracker's substate name. Unmapped substate ⇒ `ERROR`.           |
| `target_kind`       | `pr` \| `verification` \| `human-only`.                                                              |
| `human_interactive` | from the configured tracker signal (label/field). Parked roles are detected separately.              |
| `dead`              | terminated **without** `verified` and will not progress — from the configured abandoned/failed tracker signal (a label or substate). A `canceled` ticket is **not** dead: cancellation unblocks its dependents. Absent ⇒ nothing is ever permanently blocked, and an abandoned ticket blocks termination forever. |
| `priority`          | lower sorts first; default 100. Injected work is ranked by the caller's `--priority` instead.        |
| `edges_for`         | node ids whose edge set this delta restates in full. Cached edges touching them are dropped first, so a deleted dependency cannot survive. Omit it and edges are additive only. |
| `removed: true`     | on a node/milestone/project/edge: delete it from the cache.                                          |

## Derived document

What `scripts/graph derive` emits and the orchestrator consumes. It re-emits
every node with derivation tags, plus:

| section               | contents                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `available`           | ranked ids eligible for dispatch                                                              |
| `blocked`             | workable but effectively blocked (ancestor, milestone gate, or unknown blocker)               |
| `human_blocked`       | `human_interactive`, `target_kind: human-only`, or parked in `awaiting-external`              |
| `permanently_blocked` | dead, or descended from a dead node                                                           |
| `stalled`             | workable but in no other section — `backlog`, `paused`, or withheld from a cycle. Nothing dispatches these, and they hold `remaining` above zero |
| `milestones`          | `ready_for_review`, `review_recorded`, `order`, counts                                        |
| `projects` / `counts` | `total`, `verified`, `canceled`, `permanently_blocked`, `remaining`, `terminal` — per project, per milestone, and overall |
| `anomalies`           | `cycle`, `cross-project-cycle`, `unknown-blocker`, `unknown-milestone`                        |

Derivation rules, all in the script:

- **Effectively blocked** — any ancestor whose role is not `verified`/`canceled`
  (transitive), an open milestone gate, or a blocker outside the synced set.
- **Milestone gate** — a node in milestone M is blocked while any earlier
  **non-empty** milestone of its project is not both `ready_for_review` and
  `review_recorded`. An empty milestone has no review to run, so gating on one
  would deadlock the project.
- **Ready for review** — every ticket in the milestone is terminal and so is
  every ancestor of one.
- **Rank** — injected first, then priority, milestone order, how much the ticket
  unlocks, then id.
- **Available** — workable, unblocked, not parked, not human-blocked, not in a
  cycle, not in `backlog`, not excluded.
- **Cycles and unknown blockers** — withheld from `available` and reported. An
  edge naming a node outside the synced set blocks its dependent; dropping it
  would report blocked work as ready.
- **`paused` is not a human handoff** — it means stopped for other priorities, so
  it lands in `stalled`, not `human_blocked`. A tracker whose park substate means
  "waiting on a human" maps it to the `awaiting-external` role.

## Adapter contract

A per-tracker adapter is a skill named `graph-fetch-<tracker>`. Given
`projects`, an optional `cursor`, and an output path, it writes one normalized
input document and prints the path. Nothing else — no derivation, no cache.

## Linear via MCP

| need           | call                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| projects       | `list_projects` / `get_project(id)`                                                        |
| tickets        | `list_issues(project, updatedAt >= cursor, includeRelations=true)` — omit `updatedAt` for a full sync |
| edges          | each issue's `blockedBy` / `blocks` relations → one `{blocker, blocked}` each              |
| milestones     | `list_milestones(project)` → `order` from Linear's sort order                              |
| review record  | `get_status_updates(project)` — `review_recorded` iff a milestone-review update is **newer than the newest ticket in that milestone** (a review that filed follow-ups is older than them, so the re-review runs) |
| `dead`         | the configured abandoned/failed label or substate; unset it and nothing is ever permanently blocked |
| roles          | `list_issue_statuses(team)` + the Linear role table in [`work-ticket/reference.md`](../work-ticket/reference.md#linear--roles) |
| cursor         | the max `updatedAt` seen; pass it back next fetch                                          |

Set `edges_for` to every issue id the fetch returned, so a dependency removed in
Linear is removed from the cache.
