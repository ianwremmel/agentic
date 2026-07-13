---
name: build-linear-graph
description: Linear's fetch recipe and mappings for build-graph — which MCP tools to call, the real field names they return, the status→role mapping, how to get dependency edges (list_issues does not return them), milestone sort order, and the updatedAt cursor. Use together with build-graph whenever the tracker is Linear.
---

# build-linear-graph

The Linear adapter for [`build-graph`](../build-graph/SKILL.md). That skill owns
the loop — cursor, fetch, normalize, ingest, emit — and the payload contract.
This one supplies the Linear specifics: which tools to call, what they actually
return, and how their fields map onto the payload.

Read `build-graph` first. Everything it says still applies, in particular: you
fetch and normalize, the CLI does all the graph reasoning.

## The one thing that shapes the whole fetch

**`list_issues` does not return dependencies.** No relations, no blocking, in any
form. Edges come only from `get_issue` with `includeRelations: true`, one call per
issue. So the fetch is always two stages: list the issues, then fan out over them
for relations. Budget for it — a full sync of *N* issues costs *N* + a few calls,
which is why the cursor and delta path matter.

## Fetch

For each **selected** project (`build-graph` § Inputs — the caller names them):

1. **Projects.** `list_projects` → `{projects[], hasNextPage, cursor}`. Use the
   project's `id` (a uuid) as the payload's project id. Its `limit` maxes out at
   **50** — unlike `list_issues`, which goes to 250. Page, do not raise it.

2. **Milestones.** `list_milestones({project})` → `{milestones: [...]}`, each with
   `id`, `name`, `description`, `progress`, **`sortOrder`**. It returns an object,
   not a bare array, and it does not paginate.

   Use this tool, not `list_projects({includeMilestones: true})`: the copies
   embedded in a project carry a `targetDate` but **no `sortOrder`**, and sort
   order is what decides which milestone gates which.

3. **Issues.** `list_issues({project, updatedAt, orderBy: "updatedAt",
   includeArchived: false, limit: 250})` → `{issues[], hasNextPage, cursor}`. Page
   until `hasNextPage` is false, passing the returned `cursor` back as `cursor`.
   - Pass `updatedAt` only on a delta — it takes that project's stored sync cursor
     (ISO-8601, or a duration like `-P1D`). Omit it for a full fetch.
   - `updatedAt` means *updated **after***, so the ticket the cursor came from is
     excluded next tick. That is correct — you already have it. Do not "fix" it by
     backdating the cursor.
   - `includeArchived` **defaults to true**. Pass `false`, or archived tickets
     become graph nodes.
   - `limit` defaults to **50**, max 250. Set it, or you will quietly page more
     than you need to.
   - Sub-issues come back alongside their parents and **are** ordinary nodes; it
     is only the `parentId` link that is dropped (see below).

4. **Relations.** `get_issue({id, includeRelations: true})` for every issue from
   step 3 → `relations.blocks[]`, `relations.blockedBy[]`, `relations.relatedTo[]`,
   `relations.duplicateOf`. Each entry is `{id, title}` and nothing else.
   - Map **`blockedBy` → `blockedBy`** and **`blocks` → `blocks`**. Ignore
     `relatedTo` and `duplicateOf`: they are not dependencies and must not become
     edges.
   - Declare **both** directions for issues in a selected project, so an edge
     survives whichever endpoint a delta happened to see.

5. **Cross-project ancestors.** A `blockedBy` entry often names an issue in
   another project. `get_issue` it, add it as a node, and repeat for *its*
   `blockedBy` until nothing new appears. For these out-of-scope ancestors declare
   **`blockedBy` only** — never their `blocks`, which would pull in their
   descendants and, through them, most of the workspace. Do not add their project
   to `projects[]`, and do not keep a cursor for it: the document marks it
   `partial` on its own.

## Field mapping

Issue fields, as `list_issues` and `get_issue` actually return them:

| Payload field | Linear field    | Note                                                                     |
| ------------- | --------------- | ------------------------------------------------------------------------ |
| `id`          | `id`            | **This is the identifier** — `"CLC-945"`, not a uuid. Relations use it too. |
| `project`     | `projectId`     | The uuid. (`project` is the project's *name*.)                           |
| `state`       | `status`        | The status **name** string, e.g. `"In Review"`. Not an object.           |
| `milestone`   | `projectMilestone.id` | Key is absent when the issue is in no milestone.                   |
| `url`         | `url`           |                                                                          |
| `title`       | `title`         |                                                                          |
| `labels`      | `labels`        | Already an array of plain strings.                                       |
| `branchHint`  | `gitBranchName` | **`gitBranchName`** — there is no `branchName` field.                    |
| `updatedAt`   | `updatedAt`     |                                                                          |
| `priority`    | `priority.value`| **Normalize — see below.**                                              |

There is no `identifier`, `state`, or `branchName` field on an issue, and
`description` comes back truncated from `list_issues`. None of that matters for
the graph — but do not reach for a field that is not in the table above without
checking that it exists.

`parentId` **does** exist (it holds an identifier, e.g. `"CLC-968"`), and it is
deliberately **not** in the payload. A sub-issue is not a dependency: a parent is
not blocked by its children in the dependency sense, and modelling it as an edge
would gate work that is actually startable. Decomposition is the coordinator's
business. Drop `parentId`.

### Priority must be normalized

Linear's scale is `0 = None, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low` (the API
spells 0 as `"No priority"`). The payload's `priority` means **lower is more
urgent**, so 1–4 pass through unchanged, but `0` does **not**: it means *no
priority*, not *most urgent*. Send no `priority` at all when `priority.value` is
0. Passing 0 through would rank every unprioritized ticket ahead of every urgent
one.

### Status → role

The CLI's built-in `linear` mapping, keyed on the status **name**
(case-insensitive):

| Linear status | Role          |
| ------------- | ------------- |
| Backlog       | `backlog`     |
| Todo          | `available`   |
| In Progress   | `in-progress` |
| In Review     | `in-review`   |
| Finished      | `finished`    |
| Delivered     | `delivered`   |
| Done          | `verified`    |
| Canceled      | `canceled`    |
| Duplicate     | `canceled`    |

Send the status name as `state` and let the CLI map it. Do not pre-resolve roles.

A team with custom statuses will hit exit 4 (`no mapping for the native state
X`). That is working as intended — **do not guess**. Check the team's statuses
with `list_issue_statuses({team})`, which returns `{id, type, name}` where `type`
is one of `backlog`, `unstarted`, `started`, `completed`, `canceled`,
`duplicate`. The `type` tells you the status's *group*, which usually makes the
right role obvious — but the role is the operator's call to confirm, and it goes
in the config file's `states` map, not in a guess at fetch time.

Linear has no native `paused` or `awaiting-external` status. A team that wants
them adds custom statuses in Linear's Backlog group and maps them in the config.
Without them, a ticket a coordinator parks for a human is signalled by the
`human-led` label instead.

## Cursor

**One cursor per project**, keyed `linear:<project-id>`. Its value is the latest
`updatedAt` you saw **among that project's own issues**. Carry them in the
payload's `cursors` object:

```json
"cursors": { "linear:22ace2e6-…": "2026-07-11T09:12:04.000Z" }
```

Never collapse them into one shared cursor. The newest timestamp in project A
would become the changed-since bound for project B, and B's older changes would
be skipped on every subsequent tick. Cross-project ancestors do **not** advance
any cursor — you did not sync their project, you only borrowed a few of its
tickets.

Two `cursor`s are in play and they are not the same thing. `list_issues` returns
a **pagination** `cursor` (an issue uuid) for the *next page* of one fetch — that
one is never stored. The **sync** cursor is the `updatedAt` timestamp, and it is
the one the payload carries and the CLI persists.

## Gotchas

- A delta sees only issues whose `updatedAt` moved. If a delta produces a
  `dangling-edge` anomaly — an edge naming an issue you did not fetch — fetch the
  missing issues, or re-run with `--full`.
- **Pagination is uneven.** `list_teams`, `list_projects`, and `list_issues`
  return `{<items>, hasNextPage, cursor}`. `list_milestones` returns
  `{milestones: [...]}` with no pagination. `list_issue_statuses` returns a bare
  array. Do not assume one envelope.
- The `human-led` label is the default human-interactive signal, so a ticket
  carrying it is never dispatched to a coordinator. Confirm the team actually uses
  that label; rename it in the config if not.
- A project whose issues are all still in `Backlog` yields an **empty frontier**,
  and every ticket reads `dormant`. That is not a bug and not something to work
  around: nothing has been promoted to `Todo`, so there is nothing to pick up.
  Report it — a human moves the work into `Todo`.
