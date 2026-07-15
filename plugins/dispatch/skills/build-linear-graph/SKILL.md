---
name: build-linear-graph
description: Linear specifics for build-graph — the MCP tools, field mapping, and cursor to fetch a Linear project's tasks, milestones, and dependencies. Use with build-graph whenever the tracker is Linear.
---

# build-linear-graph

The Linear adapter for [`build-graph`](../build-graph/SKILL.md), which owns the
loop and the CLI.

## Fetch

Per selected project:

| Step         | Call                                                 | Take                                                |
| ------------ | ---------------------------------------------------- | --------------------------------------------------- |
| Project      | `list_projects` (`query`)                            | `id`, `name`                                        |
| Milestones   | `list_milestones` (`project`)                        | `id`, `name`, `sortOrder`                           |
| Tasks        | `list_issues` (`project`, `limit: 250`, `updatedAt`) | see the mapping below                               |
| Dependencies | `get_issue` (`id`, `includeRelations: true`)         | `relations.blocks[].id`, `relations.blockedBy[].id` |

- `list_issues` does not return relations. `get_issue` every task in the delta,
  in parallel batches.
- Page on `hasNextPage` / `cursor` (that `cursor` is pagination, not the sync
  cursor).
- A `blockedBy` id outside the selected projects is still a blocker:
  `get_issue` it, write it, and repeat until every blocker is written.

## Map to CLI flags

| CLI                              | Linear                                                    |
| -------------------------------- | --------------------------------------------------------- |
| `task set --id`                  | `id` (the identifier `CLC-945`, not the UUID)             |
| `task set --project`             | `projectId`                                               |
| `task set --role`                | `status`, mapped by the table below                       |
| `task set --milestone`           | `projectMilestone.id`                                     |
| `task set --priority`            | `priority.value`; omit when `0` (`0` = no priority)       |
| `task set --url / --title`       | `url` / `title`                                           |
| `task set --branch-hint`         | `gitBranchName`                                           |
| `task set --labels`              | `labels`, comma-joined                                    |
| `task set --updated-at`          | `updatedAt`                                               |
| `edge set --blocked/--blockers`  | the issue / `relations.blockedBy[].id`, comma-joined      |

**Status → role.** Map the status name (case-insensitive):

| Linear status | `--role`      |
| ------------- | ------------- |
| `Backlog`     | `backlog`     |
| `Todo`        | `available`   |
| `In Progress` | `in-progress` |
| `In Review`   | `in-review`   |
| `Finished`    | `finished`    |
| `Delivered`   | `delivered`   |
| `Done`        | `verified`    |
| `Canceled`    | `canceled`    |
| `Duplicate`   | `canceled`    |

A status not in this table is escalated to the operator unless its lifecycle
meaning is unambiguous (a "Ready for QA" column is `in-review`) — a wrong role
silently dispatches, or strands, real work.

**Milestone order.** Sort milestones by `sortOrder` and chain adjacent pairs:
`edge add --blocker <prev> --blocked <next>`.

## Cursor

The sync cursor is the latest `updatedAt` you fetched. Pass it back as
`list_issues`' `updatedAt` (which filters to "updated after"), and store it with
`dispatch graph cursor --source linear --set <ts>`. Both a status change and a
relation change bump `updatedAt`, so one delta sees both.

## Archived tasks

Do not `task rm` an archived task — Linear archives completed work, and its
`Done`/`Canceled` status still counts toward its milestone.
