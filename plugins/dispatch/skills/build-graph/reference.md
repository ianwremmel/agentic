# build-graph — reference

## The payload

One JSON object on stdin (or `--file`). Keys may be camelCase or snake_case.

```json
{
  "cursor": "2026-07-11T00:00:00.000Z",
  "projects": [{"id": "proj-1", "name": "Switchboard"}],
  "milestones": [
    {"id": "m1", "project": "proj-1", "name": "M1", "sortOrder": 1}
  ],
  "nodes": [
    {
      "id": "CLC-945",
      "project": "proj-1",
      "url": "https://linear.app/…/CLC-945",
      "title": "Add the thing",
      "state": "In Progress",
      "milestone": "m1",
      "priority": 2,
      "labels": ["infra"],
      "branchHint": "clc-945-add-the-thing",
      "updatedAt": "2026-07-11T00:00:00.000Z",
      "blockedBy": ["CLC-944"],
      "blocks": ["CLC-946"]
    }
  ]
}
```

### Node fields

| Field              | Required | Notes                                                                                              |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| `id`               | yes      | Tracker's human identifier (`CLC-945`), not a UUID. Every other field references it.               |
| `project`          | yes      | Project id. A project named here but never declared is partial, and never reported terminal.       |
| `state` or `role`  | yes      | `state` is the tracker's native state, mapped to a role. `role` is already resolved, and wins.     |
| `url`, `title`     | no       | Carried through to the document.                                                                   |
| `milestone`        | no       | Milestone **id**, as a string. Not an object.                                                      |
| `priority`         | no       | Lower is more urgent. Omit when the tracker has none — it then ranks last.                         |
| `labels`           | no       | Derives `targetKind` and `humanInteractive` unless those fields are set explicitly.                |
| `targetKind`       | no       | `pr` (default) \| `verification` (no-PR) \| `human-only`.                                          |
| `humanInteractive` | no       | `true` parks it for a human. A JSON boolean, never the string `"true"`.                            |
| `injected`         | no       | `true` ranks it to the top of the frontier.                                                        |
| `branchHint`       | no       | Branch-name seed.                                                                                  |
| `updatedAt`        | no       | The tracker's own timestamp. Also what invalidates a stale milestone review.                       |
| `blockedBy`        | no       | Ids that block this ticket. Authoritative for that direction — see below.                          |
| `blocks`           | no       | Ids this ticket blocks. Same.                                                                      |
| `deleted`          | no       | `true` removes the ticket and its edges. Only `id` is needed.                                      |

### Edge semantics

`blockedBy` and `blocks` are authoritative **for that ticket in that direction**:

- present (including `[]`) — replaces that direction's edges for the ticket.
- absent — this fetch says nothing about that direction; the stored edges stand.

A delta that fetched only `blockedBy` must omit `blocks`, or the ticket's `blocks`
edges are deleted.

Both ends may declare the same edge; it is stored once.

## Commands

| Command                                          | Does                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `dispatch graph ingest [--full] [--file <path>]` | Merge a payload (stdin by default). `--full` rebuilds the graph. |
| `dispatch graph doc [--format xml\|json]`        | Emit the derived document on stdout.                             |
| `dispatch graph cursor [--set <token>]`          | Read (or set) the sync cursor. Empty = never synced.             |
| `dispatch graph exclude add\|remove\|list`       | Withhold in-flight / done / failed tickets.                      |
| `dispatch graph record-review <milestone>`       | Record the §2.3 milestone review; opens the gate.                |

Shared flags: `--tracker <name>` (default `linear`), `--source <name>` (cursor
namespace, default: the tracker), `--db <path>`, `--config <path>`.

## Exit codes

| Code | Means                   | Do                                          |
| ---- | ----------------------- | ------------------------------------------- |
| 0    | success                 | —                                           |
| 1    | a bug in the CLI        | report it; retrying will not help           |
| 2    | called wrong            | fix the invocation                          |
| 3    | the environment refused | retry; escalate if it persists              |
| 4    | bad data                | fix the payload or the config, then re-run  |

Every failure prints `error:` and a `hint:` line saying what to change.

## Config

`--config <path>`, else `$DISPATCH_GRAPH_CONFIG`, else `./.dispatch/graph.json`
if it exists. All keys optional:

```json
{
  "states": {"Ready for QA": "in-review"},
  "humanInteractiveLabels": ["human-only", "needs-human"],
  "verificationLabels": ["verification"],
  "parkedRoles": ["awaiting-external", "paused"]
}
```

`states` maps a native tracker state onto a protocol role, overriding the built-in
table (§2.3 team override).

## Storage

SQLite, at `--db`, else `$DISPATCH_GRAPH_DB`, else
`$XDG_STATE_HOME/dispatch/graph.db`. Ingests are transactional, so a failed sync
leaves the previous graph intact.

`--full` rebuilds tickets, edges, milestones, and projects, dropping whatever the
tracker no longer returns. Exclusions and review records survive it — they are the
orchestrator's, not the tracker's.
