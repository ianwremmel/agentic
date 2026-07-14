---
name: build-linear-graph
description: Linear specifics for build-graph — the MCP tools, field mapping, and cursor to fetch a Linear project's tickets, milestones, and dependencies. Use with build-graph whenever the tracker is Linear.
---

# build-linear-graph

The Linear half of [`build-graph`](../build-graph/SKILL.md), which owns the loop
and the payload.

## Fetch

Per selected project:

| Step         | Call                                                 | Take                                                |
| ------------ | ---------------------------------------------------- | --------------------------------------------------- |
| Project      | `list_projects` (`query`)                            | `id`, `name`                                        |
| Milestones   | `list_milestones` (`project`)                        | `id`, `name`, `sortOrder`                           |
| Tickets      | `list_issues` (`project`, `limit: 250`, `updatedAt`) | see the mapping below                               |
| Dependencies | `get_issue` (`id`, `includeRelations: true`)         | `relations.blocks[].id`, `relations.blockedBy[].id` |

- **`list_issues` does not return relations.** `get_issue` every ticket in the
  delta, in parallel batches.
- **Page** on `hasNextPage` / `cursor` (that `cursor` is pagination, not the sync
  cursor).
- **Chase blockers out of scope, transitively.** A `blockedBy` id outside the
  selected projects is still a real blocker: `get_issue` it with
  `includeRelations: true`, emit it as a node, and repeat until every blocker is
  fetched. Those projects come back partial; that is correct.

## Map

`url`, `title`, `labels`, and `updatedAt` carry the same names on both sides.

| Payload     | Linear                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------ |
| `id`        | `id` (the identifier, e.g. `CLC-945` — not the UUID)                                       |
| `project`   | `projectId`                                                                                |
| `state`     | `status` (the name: `Backlog`, `Todo`, `In Progress`, `In Review`, `Delivered`, `Done`, …) |
| `milestone` | `projectMilestone.id` — the id, not the object                                             |
| `priority`  | `priority.value` — **omit when `0`** (`0` = unset; sent through, it outranks `1`, Urgent)  |
| `branchHint`| `gitBranchName`                                                                             |
| `blockedBy` | `relations.blockedBy[].id`                                                                 |
| `blocks`    | `relations.blocks[].id`                                                                    |

`status` maps through the built-in Linear table (`Todo` → `available`, `Done` →
`verified`, `Canceled`/`Duplicate` → `canceled`, …). A custom state fails ingest
and names itself; map it in the config's `states` — never guess.

## Cursor

The sync cursor is the **latest `updatedAt` you fetched**. Pass it back as
`list_issues`' `updatedAt` (which filters to "updated after"), and put it in the
payload's `cursor`.

```bash
since="$(dispatch graph cursor --source linear)"   # empty on first run
# empty  -> list_issues without updatedAt, then ingest --full
# set    -> list_issues updatedAt=$since, then ingest (delta)
```

Both a status change and a relation change bump `updatedAt`, so one delta sees
both.

## Archived and deleted tickets

Do **not** emit `deleted` for an archived ticket — Linear archives completed work,
whose `Done`/`Canceled` status still counts toward its milestone. A ticket that
truly left the tracker disappears on the next `--full` sync.
