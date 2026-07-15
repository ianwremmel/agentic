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
- Chase a `blockedBy` id outside the selected projects — it is still a real
  blocker. `get_issue` it, write it, and repeat until every blocker is written.

## Map to CLI flags

| CLI                              | Linear                                                    |
| -------------------------------- | --------------------------------------------------------- |
| `task set --id`                  | `id` (the identifier `CLC-945`, not the UUID)             |
| `task set --project`             | `projectId`                                               |
| `task set --role`                | `status`, mapped by the table below                       |
| `task set --milestone`           | `projectMilestone.id`                                     |
| `task set --priority`            | `priority.value` — **omit when `0`** (`0` = no priority)  |
| `task set --url / --title`       | `url` / `title`                                           |
| `task set --branch-hint`         | `gitBranchName`                                           |
| `task set --labels`              | `labels`, comma-joined                                    |
| `task set --updated-at`          | `updatedAt`                                               |
| `edge add --blocker/--blocked`   | `relations.blockedBy[].id` blocks the issue              |

Passing Linear's `0` priority through would rank an unprioritized task ahead of
`1` (Urgent), so omit `--priority`.

**Status → role.** The CLI accepts only normalized roles; you do the mapping
(case-insensitively on the status name):

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

A duplicate is abandoned work that will not be done, which is the `canceled`
role. For a workspace's custom status not in this table, map it yourself only
when its lifecycle meaning is unambiguous (a "Ready for QA" column is
`in-review`); otherwise escalate to the operator. Never guess — a wrong role
silently dispatches, or strands, real work.

**Milestone order.** Linear orders milestones by `sortOrder`; the graph sequences
them with edges. Sort the milestones by `sortOrder` and chain them:
`edge add --blocker <prev> --blocked <next>` for each adjacent pair.

## Cursor

The sync cursor is the latest `updatedAt` you fetched. Pass it back as
`list_issues`' `updatedAt` (which filters to "updated after"), and store it with
`dispatch graph cursor --source linear --set <ts>`. Both a status change and a
relation change bump `updatedAt`, so one delta sees both.

## Archived tasks

Do not `task rm` an archived task — Linear archives completed work, and its
`Done`/`Canceled` status still counts toward its milestone. A task that truly left
the tracker is pruned by the next `reset` + full sync.
