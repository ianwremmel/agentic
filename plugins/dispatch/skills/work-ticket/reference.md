# work-ticket — protocol reference

The lookup tables and recaps [`SKILL.md`](./SKILL.md) leans on. Bundled so the
skill is self-contained once installed. Where this file and the spec differ, the
spec is authoritative: §2.1 Communication, §2.3 Ticket Workflow, §2.4 Delivery,
§2.5 Ticket Coordination, §2.6 Orchestration.

## Roles

- **Coordinator** — this skill. Owns exactly one tracked work item end-to-end.
- **Operator** — the one human directing this run; the only human with stop
  authority. Identity is `operator_login`.
- **Delivery worker** — a [`deliver`](../deliver/SKILL.md) (§2.4) instance the
  coordinator drives, one per PR. Holds the compute slot while it builds; the
  coordinator does not read its PR status except through §2.4/§2.2.
- **Orchestrator** — the §2.6 agent that dispatches coordinators. Absent in
  standalone runs. Owns the graph, ranking, the slot ledger, and dispatch.

## Linear ↔ §2.3 role mapping

The skill body speaks **§2.3 roles**; this is the only place Linear substates
appear. Resolution order is **team override → this default mapping → error** (never
guess an unmapped state — surface an error). This is the same mapping a future
§2.6 Linear producer reuses.

| Linear substate (group) | §2.3 group  | §2.3 role     |
| ----------------------- | ----------- | ------------- |
| Backlog                 | `backlog`   | `backlog`     |
| TODO                    | `unstarted` | `available`   |
| In Progress             | `started`   | `in-progress` |
| In Review               | `started`   | `in-review`   |
| Finished                | `started`   | `finished`    |
| Delivered               | `started`   | `delivered`   |
| Done                    | `completed` | `verified`    |
| Canceled                | `canceled`  | `canceled`    |

Linear's top-level groups (`Backlog`, `Unstarted`, `Started`, `Completed`,
`Canceled`) cannot be customized and map directly to the protocol groups.
`paused` and `awaiting-external` are **not** in the default Linear set: a team that
needs them MUST add custom substates in Linear's **Backlog** group and map them in
a team override. A park MUST target a substate that maps to `awaiting-external` (or
`paused`); if the team has mapped **neither**, the coordinator MUST surface an
`ERROR` rather than park onto an arbitrary Backlog substate — moving to the bare
`backlog` role is **not** a §2.3 park transition and is non-conforming.

## Tracker operations

Each §2.3 operation the coordinator performs, and its Linear MCP realization.
Reads/writes follow §2.1 mode rules; the access mechanism (here, MCP) is orthogonal
to the §2.1 mode.

| §2.3 operation                     | Linear MCP realization                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fetch own brief                    | `get_issue(id, includeRelations=true)` → description, acceptance criteria, links, one-edge relations. `list_comments(issueId)` if criteria live in comments.                                         |
| Resolve current role               | `get_issue(id)` → `state` (name + type); `list_issue_statuses(team)` to enumerate the team's states; map via §Role mapping.                                                                          |
| Resolve own identity               | `get_user("me")`.                                                                                                                                                                                    |
| Read assignee (claim guard)        | `get_issue(id)` → `assignee`. If a `started`-group role is assigned to another identity, do not proceed.                                                                                             |
| Assign to self                     | `save_issue(id, assignee="me")`.                                                                                                                                                                     |
| Transition role                    | `save_issue(id, state=<target Linear substate>)`, choosing the substate that maps to the target §2.3 role.                                                                                           |
| DoD / progress / ticket↔PR comment | `save_comment(issueId, body=<§2.1-wrapped body>)` — a top-level thread on the issue. The DoD artifact and the ticket↔PR mapping always live on the **ticket**.                                       |
| State-change comment               | Post to the **primary venue** (§2.3): the **PR** if one exists (on the forge, via `deliver`'s wire format — *not* Linear MCP), else the ticket via `save_comment(issueId, …)`.                       |
| File a subtask                     | `save_issue(title, team, parentId=<parent id>)` — Linear native sub-issue.                                                                                                                           |
| `blocks` edge (subtask→parent)     | `save_issue(id=<subtask>, blocks=[<parent id>])` — append-only.                                                                                                                                      |
| `blocks` edge (blocker→current)    | `save_issue(id=<blocker>, blocks=[<current id>])`.                                                                                                                                                   |
| Read one-edge neighbors            | `get_issue(id, includeRelations=true)` → `blockedBy` (predecessors) and `blocks` (successors). One edge only.                                                                                        |
| Scan for an unresolved human alert | On the **ticket** venue, `list_comments(issueId)` and look for an unresolved comment bearing the alert sentinel; on the **PR** venue, scan the forge per `deliver`. Enforces "≤1 outstanding alert". |

PR-venue writes (the state-change comment when a PR exists, a human alert routed to
the PR) go through the **forge** (GitHub) under §2.1's wire format, the same path
`deliver` uses — they are not Linear MCP calls. Linear rejects self-blocking and
(per §2.3) dependency cycles MUST be refused at write time and surfaced at read
time. The coordinator MUST NOT create a cross-tracker dependency.

## §2.1 communication recap

Mode and wire format are shared with `deliver` (see
[`../deliver/reference.md`](../deliver/reference.md) for the full treatment).
Essentials:

- **Mode** is set by the credential held at write time. **Mode A**
  (agent-credentialed) iff the platform types the account a bot/integration, or the
  identifier matches `*copilot*` / `*codex*` / `*claude*` / `*ai-agent*`
  case-insensitively. **Mode B** (human-credentialed) otherwise; on any ambiguity
  default to Mode B.
- Every agent-authored post carries the machine marker `<!-- agent-reply:<agent-id> -->`
  as its **first line**, alone. In **Mode B** the body is additionally wrapped in a
  sparkle block (`✨` alone, one blank line in from the body each side) after the
  marker. Any durable sentinel (plan, engagement, human-alert) sits **inside** the
  body — after the marker in Mode A, after the opening sparkle in Mode B — never as
  the leading line.
- **Terminal signals** suppress re-evaluation: reactions `+1` (addressed) / `-1`
  (rejected, with a reply) / `rocket` (shipped); or, on platforms without
  reactions, the text tokens `Done.` / `Declined.` / `Shipped.` as the **last
  non-empty line**. The agent MUST NOT resolve a thread (a human's call).
- **Human-input routing** (the §2.3 rule): first applicable of **PR → ticket →
  new ticket**; tag at least one human; then the work waits, logged `WAIT`.

## Outcomes (§2.5)

What each reported outcome means and how work resumes.

| Outcome         | Meaning                                                                                                          | Terminal?                 | Resumes how                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `verified`      | Ticket-backed only: aims validated and the §2.3 DoD artifact posted; ticket at `verified`.                       | yes                       | —                                                                                          |
| `canceled`      | Work abandoned: a ticket canceled per §2.3 with a rationale, or a ticketless bare PR closed without merging.     | yes                       | —                                                                                          |
| `delivered`     | The change landed. Ticket-backed: all required PRs merged, verification owned elsewhere. Bare PR: the PR merged. | ticket: no / bare PR: yes | (ticket) a separate verification coordinator takes it to `verified`; a bare PR is done.    |
| `human-blocked` | Parked in `awaiting-external` pending a human; exactly one alert posted.                                         | no                        | re-dispatched from a fresh claim once the human resolves it.                               |
| `decomposed`    | Split into subtasks; parent stays `in-progress`, effectively blocked by the subtasks.                            | no                        | parent re-enters work and is finalized once all subtasks reach `verified`/`canceled`.      |
| `failed`        | Could not complete; reason recorded. Verification work carries a `retryable` flag.                               | no                        | retryable verification → auto-re-dispatch on a later tick; otherwise the operator decides. |

## Dispatch artifacts

**Standalone runs write none of this** — they report the outcome to the session
and stop. A **dispatched** coordinator honors the §2.6 dispatch contract. §2.6
owns the concrete location and transport; the shapes below are the stub a
standalone build conforms to so the orchestrator wires in the real paths with no
refactor. Default base: `${DISPATCH_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dispatch}/work-ticket/<key>/`,
where `<key>` is the `ticket_id` (ticket-backed) or `<repo>#<pr_number>` (bare PR).

- **Liveness lock** — `lock.json`, **ticket-keyed** (ticket-backed) or
  **PR-keyed** (bare PR). Heartbeated on a fixed interval; staleness is judged by
  lock age, so a crashed coordinator is reclaimed by the orchestrator's stale-lock
  sweep. A mirrored "working" label/signal on the forge/tracker is kept in sync
  with the lock where one is available.

  ```json
  { "key": "DEV-123", "agent_id": "<agent-id>", "kind": "ticket|pr",
    "pid": 0, "heartbeat": "<RFC3339>" }
  ```

- **Outcome artifact** — `outcome.json`, written as the coordinator's **final
  action**, read by the orchestrator to reconcile.

  ```json
  { "key": "DEV-123", "outcome": "verified|canceled|delivered|human-blocked|decomposed|failed",
    "ticket_url": "<url|null>", "pr_urls": ["<url>", "..."],
    "retryable": null, "subtasks": [], "detail": "<one-line reason>" }
  ```

  `retryable` is a boolean **only** for a `failed` verification (otherwise `null`).
  `subtasks` lists the filed subtask identifiers on a `decomposed` outcome. The
  coordinator owns its ticket's §2.3 transitions and DoD artifact; on a terminal
  outcome the orchestrator does **cleanup only** (lock, "working" label, worktree,
  the artifact) and never force-releases a live delivery worker's compute slot.

The **compute-slot ledger** itself (`MAX_PARALLEL` entries shared by all agents)
is the orchestrator's infrastructure, not written here — see §Slot seam in
`SKILL.md` and §2.6 §Slot accounting.

## Logging (§2.3)

One line per entry:

```
<timestamp> <kind> ticket=<ticket-url> pr=<pr-url> ticket-role=<role> pr-state=<pr-state> | <message>
```

| Field           | Format                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `<timestamp>`   | RFC 3339 with timezone offset, second precision.                                                |
| `<kind>`        | `TRANSITION` \| `WAIT` \| `RESUME` \| `BLOCK` \| `INFO` \| `ERROR`.                             |
| `ticket=`/`pr=` | Full URLs, never bare IDs; `-` when absent.                                                     |
| `<role>`        | The §2.3 role, e.g. `in-progress`; `-` if no ticket.                                            |
| `<pr-state>`    | `draft` \| `open` (non-terminal) or `shipped` \| `abandoned` (resolved terminal); `-` if no PR. |
| `<message>`     | Free text, one line. REQUIRED for `TRANSITION`, `WAIT`, `RESUME`, `BLOCK`, `ERROR`.             |

| Kind         | When to emit                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `TRANSITION` | Whenever the coordinator transitions a ticket's role.                                               |
| `WAIT`       | Work transitions to awaiting a response or external condition; message names venue + outcome.       |
| `RESUME`     | The awaited response arrives / condition is met and active work resumes.                            |
| `BLOCK`      | Filing a new out-of-scope blocking ticket.                                                          |
| `INFO`       | Substantive non-state-change events: subtask creation, reassignment, ticket↔PR mapping, heartbeats. |
| `ERROR`      | Tracker errors, verification failures, and conditions surfaced but not immediately fatal.           |

When the coordinator transitions a ticket's role it MUST **also** post a §2.3
state-change comment to the primary venue (PR if one exists, else ticket), body
exactly:

```
State: <prev-role> → <new-role>
Rationale: <one line; required for corrective and cancel transitions>
```

The comment follows §2.1 (machine marker; Mode B sparkle wrapper).
