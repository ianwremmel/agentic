# work-ticket — reference

Lookup tables for [`SKILL.md`](./SKILL.md), bundled so the skill is self-contained.

## Roles

- **Coordinator** — this skill; owns one work item end-to-end.
- **Operator** — the human directing this run; identity is `operator_login`.
- **Delivery worker** — a [`deliver`](../deliver/SKILL.md) instance, one per
  PR; holds the compute slot while building. Read its PR status only via `deliver`.
- **Orchestrator** — the agent that dispatches coordinators; owns the graph,
  ranking, the slot ledger, and dispatch. Absent standalone.

## Linear ↔ roles

The body speaks role names; this is the only place tracker substates appear.
Resolution order: **team override → default below → error** (never guess). The same
mapping a Linear producer reuses. Adding a tracker = adding its mapping here.

| Linear substate | role group  | role          |
| --------------- | ----------- | ------------- |
| Backlog         | `backlog`   | `backlog`     |
| TODO            | `unstarted` | `available`   |
| In Progress     | `started`   | `in-progress` |
| In Review       | `started`   | `in-review`   |
| Finished        | `started`   | `finished`    |
| Delivered       | `started`   | `delivered`   |
| Done            | `completed` | `verified`    |
| Canceled        | `canceled`  | `canceled`    |

Linear's top-level groups map 1:1 to the protocol groups. `paused` and
`awaiting-external` aren't in the default set — a team needing them adds Backlog
substates and maps them in a team override. A park MUST land on a substate mapping
to `awaiting-external`/`paused`; if neither is mapped, `ERROR` (bare `backlog` is
not a park).

## Tracker operations (Linear)

Reads/writes follow the Mode A/B rules; MCP access is orthogonal to the mode.

| operation                                   | Linear MCP                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| fetch brief                                 | `get_issue(id, includeRelations=true)`; `list_comments(issueId)` if criteria live in comments                     |
| resolve role                                | `get_issue(id).state`; `list_issue_statuses(team)`; map above                                                     |
| own identity                                | `get_user("me")`                                                                                                  |
| claim guard                                 | `get_issue(id).assignee` — a `started` role held by another identity ⇒ stop                                       |
| assign self                                 | `save_issue(id, assignee="me")`                                                                                   |
| transition                                  | `save_issue(id, state=<substate mapping to target role>)`                                                         |
| ticket comment (DoD / progress / ticket↔PR) | `save_comment(issueId, body)` — DoD and the mapping always live on the ticket                                     |
| state-change comment                        | the **primary venue**: the PR if one exists (forge, via `deliver`'s wire format), else `save_comment(issueId, …)` |
| subtask                                     | `save_issue(title, team, parentId=<parent>)`                                                                      |
| `blocks` edge                               | `save_issue(id=<blocker/subtask>, blocks=[<blocked>])` (append-only)                                              |
| one-edge neighbors                          | `get_issue(id, includeRelations=true)` → `blockedBy` / `blocks`                                                   |
| scan open human alert                       | ticket: `list_comments` for the alert sentinel; PR: scan the forge per `deliver`                                  |

PR-venue writes go through the **forge** (GitHub), the path `deliver`
uses — not Linear MCP. Linear rejects self-blocks; cycles MUST be refused at write
and surfaced at read; no cross-tracker dependencies.

**Primary venue with several PRs** (first match): (1) the PR the event is about
(its delivery triggered the transition, or a blocker arose in it); (2) else the
most recently updated open PR; (3) else the ticket — and ticket-level transitions
(`available → in-progress`, the aggregate `delivered`, `verified`) go to the
ticket. The DoD artifact always lives on the ticket.

## Communication recap

Full treatment in [`../deliver/reference.md`](../deliver/reference.md). Essentials:
**Mode A** (agent) iff the account is a bot/integration or its id matches
`*copilot*`/`*codex*`/`*claude*`/`*ai-agent*`, else **Mode B** (default on
ambiguity). Every agent post leads with `<!-- agent-reply:<agent-id> -->` alone;
Mode B wraps the body in `✨`; sentinels sit inside the body. Terminal signals:
`+1`/`-1`(with reply)/`rocket`, or last-line `Done.`/`Declined.`/`Shipped.`; never
resolve a thread. Human-input routing: PR → ticket → new ticket, tag a human, then
`WAIT`.

## Outcomes

| outcome         | meaning                                                                | terminal?              | resumes                                                                      |
| --------------- | ---------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `verified`      | ticket-backed: aims validated, DoD posted, ticket at `verified`        | yes                    | —                                                                            |
| `canceled`      | abandoned (ticket canceled with rationale, or bare PR closed unmerged) | yes                    | —                                                                            |
| `delivered`     | landed: all required PRs merged (ticket) / the PR merged (bare PR)     | ticket: no / bare: yes | a verification coordinator takes the ticket to `verified`; a bare PR is done |
| `human-blocked` | parked in `awaiting-external`; one alert posted                        | no                     | re-dispatched from a fresh claim once resolved                               |
| `decomposed`    | split into subtasks; parent `in-progress`, blocked by them             | no                     | parent finalized once all subtasks `verified`/`canceled`                     |
| `failed`        | could not complete; reason recorded; verification carries `retryable`  | no                     | retryable verification auto-re-dispatches; else operator decides             |

## Dispatch artifacts

Standalone writes none of this (report to the session and stop). A **dispatched**
coordinator honors the orchestrator's contract, using the `dispatch-state` script
under the exported `DISPATCH_RUN_DIR`
([`orchestrate/reference.md`](../orchestrate/reference.md#run-directory)).
`<key>` = `ticket_id` (ticket) or `<repo>#<pr_number>` (bare PR).

- **Lock** — `dispatch-state lock acquire <key> <agent-id> ticket|pr`, then
  `lock heartbeat <key>` on a fixed interval; mirror a "working" label where
  available. Release it only as you exit.
- **`outcome.json`** — written as the final action, in `unit dir <key>` (ask the
  script for the path; keys are encoded, so never build it by hand).
  `{ "key":"DEV-123", "outcome":"…", "ticket_url":"…|null", "pr_urls":[…], "retryable":null, "subtasks":[], "detail":"…" }`
  (`retryable` is a boolean only for a `failed` verification; `subtasks` lists filed
  ids on `decomposed`.)

The compute-slot **ledger** (`DISPATCH_MAX_PARALLEL`) lives in the same run dir
but is shared by every agent on the host — take entries via `dispatch-state slot`,
never by writing the files (see Slot seam in `SKILL.md`).

## Logging

```
<timestamp> <kind> ticket=<url> pr=<url> ticket-role=<role> pr-state=<state> | <message>
```

`<timestamp>` RFC 3339 + offset, second precision. `<kind>` =
`TRANSITION`|`WAIT`|`RESUME`|`BLOCK`|`INFO`|`ERROR` (message required for all but
`INFO`). `ticket=`/`pr=` full URLs, `-` if absent. `<pr-state>` =
`draft`|`open`|`shipped`|`abandoned`, `-` if no PR.

| kind         | when                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| `TRANSITION` | a ticket role change                                                      |
| `WAIT`       | entering a wait (name venue + awaited outcome)                            |
| `RESUME`     | the awaited condition is met                                              |
| `BLOCK`      | filing an out-of-scope blocking ticket                                    |
| `INFO`       | substantive non-state events (subtasks, mapping, reassignment, heartbeat) |
| `ERROR`      | tracker errors, verification failures                                     |

Every role change also posts a state-change comment to the primary venue, body
exactly (then the Mode A/B wrapping):

```
State: <prev-role> → <new-role>
Rationale: <one line; required for corrective and cancel transitions>
```
