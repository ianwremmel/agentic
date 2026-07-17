---
name: tracker-adapter-linear
description: Linear tracker adapter for dispatch — binds work-ticket's roles and ticket operations to Linear and supplies build-graph's fetch calls, field mapping, and cursor. Use whenever the ticket or project lives on Linear.
---

# tracker-adapter-linear

[`work-ticket`](../work-ticket/SKILL.md) reads Identity, Role map, Operations,
and Quirks; [`build-graph`](../build-graph/SKILL.md) reads Role map, Quirks,
and Graph fetch; [`milestone-review`](../milestone-review/SKILL.md) reads
Identity, Operations, Quirks, and Review artifact.

## Identity

| Field        | Value                                 |
| ------------ | ------------------------------------- |
| tracker id   | `linear`                              |
| ticket URLs  | `linear.app/<workspace>/issue/<ID>`   |
| ticket ids   | `<TEAM-KEY>-<number>`, e.g. `DEV-123` |
| access       | Linear MCP server                     |
| own identity | `get_user("me")`                      |

## Role map

Read the team's substates with `list_issue_statuses(team)` and match by name,
case-insensitively; each substate carries the Linear group shown here.

| Native substate | Group       | Role          |
| --------------- | ----------- | ------------- |
| Triage          | `backlog`   | `backlog`     |
| Backlog         | `backlog`   | `backlog`     |
| Todo            | `unstarted` | `available`   |
| In Progress     | `started`   | `in-progress` |
| In Review       | `started`   | `in-review`   |
| Finished        | `started`   | `finished`    |
| Delivered       | `started`   | `delivered`   |
| Done            | `completed` | `verified`    |
| Canceled        | `canceled`  | `canceled`    |
| Duplicate       | `canceled`  | `canceled`    |

`Finished` and `Delivered` are custom substates; a team without them collapses
the forward path (`in-review → delivered`, or `in-review → verified` where
neither exists). `paused` and `awaiting-external` are unmapped by default: a
team that needs them adds Backlog substates and maps them in its own copy of
this adapter. Until then a park has no substate to land on and is an `ERROR` —
moving a ticket to plain `Backlog` is not a park.

A substate this table doesn't name is handled per consumer:

- **work-ticket** (transitioning the acting ticket): an `ERROR`, not a guess —
  its Linear group narrows the role but doesn't pick it (a team's custom
  `Blocked` substate sits in `Unstarted` and is not `available`).
  Map it in your own copy.
- **build-graph** (sweeping whole projects, foreign teams included): map it
  only when its lifecycle meaning is unambiguous (a `Merged` substate is
  `delivered`); otherwise escalate to the operator — a wrong role silently
  dispatches, or strands, real work.

## Operations

| Operation          | Binding                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| fetch brief        | `get_issue(id, includeRelations=true)`; `list_comments(issueId)` when the acceptance criteria live in comments |
| resolve role       | `get_issue(id).state` → `list_issue_statuses(team)` → the role map above                                       |
| own identity       | `get_user("me")`                                                                                               |
| claim guard        | `get_issue(id).assignee`                                                                                       |
| assign self        | `save_issue(id, assignee="me")`                                                                                |
| transition         | `save_issue(id, state=<substate mapping to the target role>)`                                                  |
| ticket comment     | `save_comment(issueId, body)`                                                                                  |
| read comments      | `list_comments(issueId)` — match the alert sentinel; replies carry `parentId`                                  |
| react              | `unsupported` — no reaction call in the Linear MCP server; use the text tokens                                 |
| file ticket        | `save_issue(title, team, description)` — same team as the ticket unless the brief says otherwise               |
| subtask            | `save_issue(title, team, parentId=<parent>)`                                                                   |
| blocks edge        | `save_issue(id=<blocker>, blocks=[<blocked>])` (append-only)                                                   |
| one-edge neighbors | `get_issue(id, includeRelations=true)` → `blockedBy` / `blocks`                                                |

## Quirks

- Linear tickets are per-team: read the acting ticket's team before writing a
  state or filing into it, and don't reuse another team's substate names.
- Linear archives completed work; an archived task's `Done`/`Canceled` status
  still counts toward its milestone, so `build-graph` must not `task rm` it.

## Review artifact (milestone-review)

The review artifact is a **project status update**. Status updates are
project-scoped, not per-milestone, so the body must carry the milestone id
(the episode sentinel does) to keep concurrent milestones' reviews distinct.

| Operation              | Binding                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| milestone brief        | `get_milestone(project, query)` — the goal lives in its description                                                                     |
| find review artifact   | `get_status_updates(type="project", project)` → the newest update whose body carries the episode sentinel with this milestone's id      |
| post review artifact   | `save_status_update(type="project", project, body, health)` — `onTrack` when the goal is achieved, `atRisk` otherwise                   |
| update review artifact | `save_status_update(id, body, health)` — same update; the pending→outcome edit when human input resolved                                |
| artifact thread        | `list_comments(statusUpdateId)` / `save_comment(statusUpdateId)`; one thread per update — reply via `parentId`; tag with `@displayName` |
| file follow-up         | `save_issue(title, team, description, project, milestone)` — `milestone` takes a name or id; pick the team per Quirks                   |

Member DoD comments and canceled-member rationales are ticket reads — use the
Operations bindings above (`fetch brief`, `read comments`).

## Graph fetch (build-graph)

`build-graph` owns the loop and the CLI; this section supplies the Linear side.

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

### Map to CLI flags

| CLI                             | Linear                                               |
| ------------------------------- | ---------------------------------------------------- |
| `task set --id`                 | `id` (the identifier `CLC-945`, not the UUID)        |
| `task set --project`            | `projectId`                                          |
| `task set --role`               | `status`, mapped by the Role map above               |
| `task set --milestone`          | `projectMilestone.id`                                |
| `task set --priority`           | `priority.value`; omit when `0` (`0` = no priority)  |
| `task set --url / --title`      | `url` / `title`                                      |
| `task set --branch-hint`        | `gitBranchName`                                      |
| `task set --labels`             | `labels`, comma-joined                               |
| `task set --updated-at`         | `updatedAt`                                          |
| `edge set --blocked/--blockers` | the issue / `relations.blockedBy[].id`, comma-joined |

**Milestone order.** Sort milestones by `sortOrder` and chain adjacent pairs:
`edge add --blocker <prev> --blocked <next>`.

### Cursor

The sync cursor is the latest `updatedAt` you fetched. Pass it back as
`list_issues`' `updatedAt` (which filters to "updated after"), and store it with
`dispatch graph cursor --source linear --set <ts>`. Both a status change and a
relation change bump `updatedAt`, so one delta sees both.
