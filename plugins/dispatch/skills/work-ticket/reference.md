# work-ticket — reference

Lookup tables for [`SKILL.md`](./SKILL.md).

## Actors

- **Coordinator** — this skill; owns one work item end-to-end.
- **Operator** — the human directing this run; identity is `operator_login`.
- **Delivery worker** — a [`deliver`](../deliver/SKILL.md) instance, one per
  PR; holds the compute slot while building. Read its PR status only via `deliver`.
- **Orchestrator** — the agent that dispatches coordinators; owns the graph,
  ranking, the slot ledger, and dispatch. Absent standalone.

## Lifecycle roles

The skill body speaks these role names, never a tracker's own state names. Each
role sits in exactly one group; a tracker adapter maps every native state onto a
group and a role.

| Group       | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `backlog`   | Not currently progressing; not eligible to be picked up. |
| `unstarted` | Ready to be picked up.                                   |
| `started`   | Work is in flight.                                       |
| `completed` | Work is done.                                            |
| `canceled`  | Abandoned without completion.                            |

| Role                | Group       | Mapping     | Meaning                                               |
| ------------------- | ----------- | ----------- | ----------------------------------------------------- |
| `backlog`           | `backlog`   | optional    | Not yet ready to work on.                             |
| `paused`            | `backlog`   | optional    | Started, then stopped for other priorities.           |
| `awaiting-external` | `backlog`   | optional    | Blocked on an external condition.                     |
| `available`         | `unstarted` | required    | Eligible to be picked up.                             |
| `in-progress`       | `started`   | required    | Actively being worked.                                |
| `in-review`         | `started`   | recommended | Primary work complete; iterating with reviewers.      |
| `finished`          | `started`   | optional    | Review approved; not yet merged or deployed.          |
| `delivered`         | `started`   | recommended | Merged or deployed; not yet verified.                 |
| `verified`          | `completed` | required    | Validated against the ticket's aims; method recorded. |
| `canceled`          | `canceled`  | required    | Will not be done.                                     |

A tracker that cannot express a required role cannot be adapted; the adapter
should say so rather than approximate.

Forward path — `available → in-progress → in-review → finished → delivered →
verified`. The path **collapses** over any role the adapter leaves unmapped (no
`finished` ⇒ `in-review → delivered`; no `delivered` either ⇒ `in-review →
verified`). Never invent a native state to fill a gap, and never emit a
transition to an unmapped role. Corrective (backward) transitions, parks, and
`canceled` carry a rationale. `canceled` is terminal, and `verified → canceled`
is forbidden — regressed work goes back through `verified → in-progress`.

## Tracker adapters

An adapter is a skill named `tracker-adapter-<id>` that binds the roles and
operations above to one platform. Resolution — tracker id, and the best-effort
fallback when no adapter is installed — is in [`SKILL.md`](./SKILL.md);
authoring guidance is in the plugin README. This section is how to read one.

A more specific adapter skill **replaces** a same-id one wholesale: there is no
per-row merge — read only the winning adapter. Every ticket read and write this
skill makes goes through it.

The tracker's access mechanism (MCP, CLI, REST) is an adapter's business and is
**orthogonal** to the Mode A/B communication rules, which follow the credentials
in use.

### What an adapter contains

| Section     | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity    | The tracker id, the URL and id shapes it owns (the skill matches a ticket to an adapter on these), the MCP server or CLI its operations use, how to read the acting account.                                                                                                                                                                                                                                                                                                             |
| Role map    | Every native state the skill can encounter → one group, and a role wherever the skill must read or write that state. Rules are read **first-match, in order**: a rule may be a predicate over metadata (a linked PR's state, a close reason, an assignee) rather than a state name, and layered state (a board field over the item's own state) appears as ordered rows — apply the first row that matches.                                                                              |
| Operations  | One binding per operation below.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Quirks      | Constraints to respect: writes the tracker refuses, transitions it performs atomically as a side effect, roles it cannot express.                                                                                                                                                                                                                                                                                                                                                        |
| Graph fetch | What `build-graph` needs to sweep the tracker's projects: fetch calls, field → CLI-flag mapping, and the sync cursor. Read only by `build-graph`; required only for a tracker whose projects are graphed.                                                                                                                                                                                                                                                                                |

### Operations

Every ticket read and write the skill performs is one of these. The skill names
the operation; the adapter says how to run it.

| Operation          | Called to                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| fetch brief        | read the description, acceptance criteria, links, and relations                                                                |
| resolve role       | read the native state (and any metadata the role map's rules test) and map it to a role                                        |
| own identity       | learn the acting account (for the claim guard and assignment)                                                                  |
| claim guard        | read the current assignee                                                                                                      |
| assign self        | take the ticket                                                                                                                |
| transition         | move the ticket to the native state that maps to a target role                                                                 |
| ticket comment     | post to the ticket: state-change comments, the DoD artifact and its evidence, the ticket↔PR mapping, progress, a human alert   |
| read comments      | read the ticket's comments — find an already-open human alert before posting another, and follow replies to one (thread-aware) |
| react              | put a terminal signal on a ticket comment                                                                                      |
| file ticket        | open a new top-level ticket (out-of-scope blocker, follow-up, human-alert ticket)                                              |
| subtask            | file a child of the ticket when decomposing                                                                                    |
| blocks edge        | link a blocker to the ticket it blocks (append-only)                                                                           |
| one-edge neighbors | read direct predecessors/successors                                                                                            |

The PR half of each of these is `deliver`'s, through the forge: when the primary
venue is the PR, the comment, the alert scan, and the terminal signal all go
there and the adapter is not involved.

A `transition` binding may differ per target role — a tracker that stores some
roles and computes others (an issue whose review roles follow its linked PR, but
which is closed with a reason to reach `verified` / `canceled`) carries a binding
per stored role and `computed` for the rest. `unsupported` is otherwise a
legal binding only for the operations below; a tracker that cannot resolve a
role, comment, or file a ticket cannot be worked. Dropping the work an operation
stands for is never legal.

| Unsupported                        | Instead                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transition (`computed` for a role) | make the underlying change — don't write the tracker — then log `TRANSITION`, post the state-change comment as usual, and confirm the new role with `resolve role`. |
| react                              | close with a text token instead (`Done.` / `Declined.` / `Shipped.` as the last line of a reply), per the terminal-signal rules.                                    |
| subtask                            | `file ticket` a standalone ticket per unit and link each to the parent with a `blocks` edge; still log `INFO`.                                                      |
| blocks edge                        | state the dependency in a ticket comment on both ends and log `INFO` — a graph the tracker can't hold is still stated.                                              |
| one-edge neighbors                 | proceed without neighbor context; it is advisory.                                                                                                                   |

An unmapped park role (`paused`, `awaiting-external`) is not an `unsupported`
operation but a gap in the role map: a park then has nowhere to land, so it is an
`ERROR` (see **Human handoff** in `SKILL.md`).

### Dependency rules (every tracker)

A `blocks` edge means the blocker must reach `verified` or `canceled` before the
ticket it blocks is worked. Never write a self-edge, and never write an edge that
closes a cycle among the tickets you can see — the coordinator doesn't walk the
graph (that is the orchestrator's), so trust the tracker's own refusal where it
has one and surface any cycle you do meet as an `ERROR`. Dependencies never cross
trackers: a ticket on one tracker must not block a ticket on another.

## Primary venue

Where a state-change comment lands: the PR if one exists, else the ticket. With
several PRs, first match wins — (1) the PR the event is about (its delivery
triggered the transition, or the blocker arose in it); (2) else the most recently
updated open PR; (3) else the ticket. Ticket-level transitions (`available →
in-progress`, the aggregate `delivered`, `verified`) go to the ticket, as do the
DoD artifact and the ticket↔PR mapping.

PR-venue writes go through the **forge**, the path `deliver` uses — never the
tracker's API.

## Graph claim

Flags, store resolution, and exit codes are `dispatch graph`'s — see
[`build-graph/reference.md`](../build-graph/reference.md). `claimed`,
`refreshed` (already yours — a resume), and `reclaimed` (stale takeover) all
succeed. `held` is another agent's live claim (exit 3). Exit 4 carries the
reason: `unknown-task`, or `not-available` with the classification.

**Subgraph fetch (`unknown-task`).** Fetch the ticket and every transitive
blocker and write them:

- Each ticket: `get_issue(id, includeRelations=true)` →
  `dispatch graph task set --id … --project … --role <mapped> --url … --title …`
  (plus `--labels`/`--priority`/`--branch-hint` when present), role mapped by
  the table above; then `edge set --blocked <id> --blockers <blockedBy ids>`.
  Repeat for each blocker not yet written, to closure.
- Omit `--milestone` and never run `project set`: a slice must not make the
  project look complete or wire milestone gates it cannot see. The next full
  `build-graph` run fills those in.

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
coordinator honors the `orchestrate` contract. Base:
`${DISPATCH_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dispatch}/work-ticket/<key>/`,
`<key>` = `ticket_id` (ticket) or `<repo>#<pr_number>` (bare PR).

Ticket-backed liveness is the **graph claim** (claim/heartbeat/release per
SKILL — no lock file); mirror a "working" label where available. A bare PR has
no graph node, so it keeps a PR-keyed lock file instead:

- **`lock.json`** (bare PR only) — heartbeated every few minutes; stale after
  10m without one (the graph-claim default).
  `{ "key":"o/r#7", "agent_id":"…", "kind":"pr", "heartbeat":"<RFC3339>" }`
- **`outcome.json`** — written as the final action.
  `{ "key":"DEV-123", "outcome":"…", "ticket_url":"…|null", "pr_urls":[…], "retryable":null, "subtasks":[], "detail":"…" }`
  (`retryable` is a boolean only for a `failed` verification; `subtasks` lists filed
  ids on `decomposed`.)

No compute-slot ledger yet — see Slot seam in `SKILL.md`.

## Logging

```text
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

State-change comment body, exactly (Mode A/B wrapping applies):

```text
State: <prev-role> → <new-role>
Rationale: <one line; required for corrective and cancel transitions>
```
