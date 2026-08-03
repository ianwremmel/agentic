# build-graph — reference

Flag tables for the commands [`SKILL.md`](./SKILL.md) uses. Every command also
takes `--db` (graph database path; defaults to `$DISPATCH_DB`, else
`$XDG_STATE_HOME/dispatch/graph-v2.db`), omitted from the tables below.

## `dispatch refresh`

| Flag        | Required | Meaning                                                    |
| ----------- | -------- | ---------------------------------------------------------- |
| `--tracker` | yes      | Tracker to refresh, e.g. linear.                           |
| `--project` | yes      | Comma-separated project ids to scan.                       |
| `--rebuild` | no       | Drop the graph and scan from scratch, ignoring the cursor. |

## `dispatch refresh done`

| Flag        | Required | Meaning                                                                                     |
| ----------- | -------- | ------------------------------------------------------------------------------------------- |
| `--tracker` | yes      | Tracker whose scan is complete.                                                             |
| `--cursor`  | no       | Opaque tracker token marking how far this scan read. Recorded only when the refresh closes. |

## `dispatch refresh status`

| Flag        | Required | Meaning               |
| ----------- | -------- | --------------------- |
| `--tracker` | yes      | Tracker to report on. |

## `dispatch project set`

| Flag        | Required | Meaning                                                                      |
| ----------- | -------- | ---------------------------------------------------------------------------- |
| `--id`      | yes      | Tracker identifier for the project.                                          |
| `--name`    | yes      | Human-readable project name.                                                 |
| `--tracker` | yes      | Tracker the project lives on, e.g. linear. Every ticket in it inherits this. |

## `dispatch project rm`

| Flag   | Required | Meaning                             |
| ------ | -------- | ----------------------------------- |
| `--id` | yes      | Tracker identifier for the project. |

## `dispatch milestone set`

| Flag        | Required | Meaning                               |
| ----------- | -------- | ------------------------------------- |
| `--id`      | yes      | Tracker identifier for the milestone. |
| `--project` | yes      | Project the milestone belongs to.     |
| `--name`    | yes      | Human-readable milestone name.        |

## `dispatch milestone rm`

| Flag   | Required | Meaning                               |
| ------ | -------- | ------------------------------------- |
| `--id` | yes      | Tracker identifier for the milestone. |

## `dispatch ticket set`

| Flag               | Required | Meaning                                                                                                                                                                             |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--id`             | yes      | Tracker identifier, e.g. CLC-945.                                                                                                                                                    |
| `--project`        | yes      | Project the ticket belongs to.                                                                                                                                                       |
| `--status`         | yes      | Normalized lifecycle status. One of: backlog, paused, awaiting-external, available, in-progress, in-review, finished, delivered, verified, canceled. |
| `--title`          | no       | Ticket title.                                                                                                                                                                        |
| `--url`            | no       | Ticket URL.                                                                                                                                                                          |
| `--target-kind`    | no       | What finishing this ticket produces. One of: pr, verification, human-only. Defaults to pr.                                                                                           |
| `--requires-human` | no       | Only a human may work this ticket.                                                                                                                                                   |
| `--injected`       | no       | Rank this ticket to the top of the frontier.                                                                                                                                         |
| `--priority`       | no       | Lower is more urgent; omit if the tracker has none.                                                                                                                                  |
| `--labels`         | no       | Comma-separated tracker labels, passed through as-is.                                                                                                                                |
| `--branch-hint`    | no       | Branch-name seed the tracker suggests.                                                                                                                                               |
| `--updated-at`     | no       | When the tracker last saw the ticket move (RFC 3339).                                                                                                                                |

## `dispatch ticket rm`

| Flag   | Required | Meaning                            |
| ------ | -------- | ---------------------------------- |
| `--id` | yes      | Tracker identifier for the ticket. |

## `dispatch ticket missing`

| Flag   | Required | Meaning                                     |
| ------ | -------- | ------------------------------------------- |
| `--id` | yes      | The ticket id the tracker has no record of. |

## `dispatch edge add` / `dispatch edge rm`

| Flag        | Required | Meaning                           |
| ----------- | -------- | --------------------------------- |
| `--blocker` | yes      | The node that must resolve first. |
| `--blocked` | yes      | The node that waits on it.        |

An edge may name an id no command has written yet. The CLI records a
placeholder and issues its own `fetch_ticket` instruction for it.

## `dispatch edge set`

| Flag          | Required | Meaning                                                |
| ------------- | -------- | ------------------------------------------------------ |
| `--node`      | yes      | The node whose edges are being redeclared.             |
| `--direction` | yes      | Which side to replace. One of: blockers, blocks.       |
| `--others`    | no       | Comma-separated node ids. Omitted or empty clears the direction. |

## Exit codes

Every failure prints `error:` and a `hint:` line saying what to change.

| Code | Error              | Thrown when                                                                                                                                           |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `CommandError`     | A command fails for a reason no more specific class covers.                                                                                            |
| 1    | `DefinitionError`  | A command is defined or registered wrong — a plugin bug, not your input.                                                                               |
| 2    | `UsageError`       | A flag is missing, unknown, or outside its choices; fix the invocation.                                                                                |
| 3    | `EnvironmentError` | The process environment is unusable — a required variable or tool is absent.                                                                           |
| 4    | `DataError`        | The store refuses the write: an edge would close a cycle, `refresh done` finds no open refresh, or `ticket missing` names an id with no open request.  |
