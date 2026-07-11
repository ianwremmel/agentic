# Tracker adapter — Linear

Binds [`work-ticket`](../SKILL.md)'s roles and operations to Linear. Contract:
[`reference.md`](../reference.md#tracker-adapters).

## Identity

| Field        | Value                                 |
| ------------ | ------------------------------------- |
| tracker id   | `linear`                              |
| ticket URLs  | `linear.app/<workspace>/issue/<ID>`   |
| ticket ids   | `<TEAM-KEY>-<number>`, e.g. `DEV-123` |
| access       | Linear MCP server                     |
| own identity | `get_user("me")`                      |

## Role map

Read the team's actual substates with `list_issue_statuses(team)` and match by
name; each substate carries the Linear group shown here.

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
neither exists). `paused` and `awaiting-external` are unmapped by default: a team
that needs them adds Backlog substates and maps them in its own copy of this
adapter. With neither mapped a park is an `ERROR` — bare `backlog` is not a park.

A substate this table doesn't name is an `ERROR`, not a guess — its Linear group
narrows the role but doesn't pick it (a team's custom `Blocked` substate sits in
`Unstarted` and is emphatically not `available`). Map it in your own copy.

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

- Linear refuses self-blocks at write.
- Linear tickets are per-team: read the acting ticket's team before writing a
  state or filing into it, and don't reuse another team's substate names.
- PR-venue writes go through the forge (GitHub), not Linear MCP — a state-change
  comment whose primary venue is the PR is a `deliver` wire-format post.
