---
name: graph-fetch-linear
description: Fetch Linear projects and emit the normalized project-graph delta — issues, dependency edges, milestones, roles, and a cursor. The Linear adapter behind build-graph; invoked by it, not usually on its own.
---

# graph-fetch-linear

Turn Linear projects into one `<project-graph-delta>` document
([`build-graph/reference.md`](../build-graph/reference.md#the-delta)). Fetch and
map — no derivation, no cache, no scheduling. No Linear concept travels past this
document.

## Inputs

`projects` (one or more Linear project ids), an optional `cursor`, and an output
path. Print the path when done.

## Fetch

`cursor` is the max `updatedAt` you have already seen. Ask only for what changed
since it; omit it for a full sync (first run, recovery, or a cursor gap) and set
`full="true"` on the delta.

| need          | Linear MCP                                                                          |
| ------------- | ----------------------------------------------------------------------------------- |
| projects      | `get_project(id)`                                                                    |
| issues        | `list_issues(project, updatedAt >= cursor, includeRelations=true)`                  |
| edges         | each issue's `blockedBy` / `blocks` relations                                        |
| milestones    | `list_milestones(project)`                                                           |
| review record | `get_status_updates(project)`                                                        |
| roles         | `list_issue_statuses(team)` + the role table below                                   |

## Map

Per issue, one `<node>`: `id`, `url`, `title` (the issue title — one line, no
body), `role`, `group`, `project`, `milestone`, `target-kind`, and any
`<pr url="…"/>` from its attachments.

- **role** — map the Linear substate with the table in
  [`work-ticket/reference.md`](../work-ticket/reference.md#linear--roles)
  (team override first, then the default). An unmapped substate is an `ERROR`;
  never guess a role.
- **target-kind** — `verification` when the issue names a suite and a deployed
  target and needs no code change; `human-only` on the configured
  human-interactive signal; otherwise `pr`.
- **`human-interactive`** and **`dead`** — from their configured labels. Without
  a `dead` signal nothing is ever permanently blocked, and an abandoned issue
  blocks completion forever.
- **edges** — one `<edge blocker blocked/>` per relation. Linear's `blockedBy`
  and `blocks` are the same edge seen from both ends: emit it once.
- **milestone `order`** — Linear's milestone sort order.
- **`review-recorded`** — true only when a milestone-review status update is
  **newer than the newest issue in that milestone**. A review that filed
  follow-ups is older than them, so the gate correctly re-opens for a re-review.

List every issue you fetched under `<edges-for>`, so a dependency deleted in
Linear is deleted from the cache. Set `cursor` to the max `updatedAt` you saw.

**Never copy Linear's `priority` field into `priority`.** The graph ranks *lower
first*, while Linear's 0 means "no priority" and 1 means "urgent" — copied
verbatim, it ranks the unimportant work first. Omit the attribute, or invert it.
