# §2.3.2 — Ticket Workflow Protocol: Normative

## Roles and groups

### Groups

| Group       | Meaning                                                   |
| ----------- | --------------------------------------------------------- |
| `backlog`   | Not currently progressing; not eligible to be picked up.  |
| `unstarted` | Ready to be picked up.                                    |
| `started`   | Work is in flight.                                        |
| `completed` | Work is done.                                             |
| `canceled`  | Work was abandoned without completion.                    |

### Roles

| Role                | Group       | Required-ness | Description                                                                                |
| ------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------ |
| `backlog`           | `backlog`   | Optional      | Not yet ready to work on; promoted to `available` when ready.                              |
| `paused`            | `backlog`   | Optional      | Started but temporarily stopped due to other priorities.                                   |
| `awaiting-external` | `backlog`   | Optional      | Cannot proceed until an external condition is met.                                         |
| `available`         | `unstarted` | Required      | Eligible to be picked up by an unblocked agent.                                            |
| `in-progress`       | `started`   | Required      | An agent is actively working on this ticket.                                               |
| `in-review`         | `started`   | Recommended   | Primary work complete; iterating with reviewers.                                           |
| `finished`          | `started`   | Optional      | Review approved; not yet merged or deployed.                                               |
| `delivered`         | `started`   | Recommended   | Merged or deployed; not yet verified.                                                      |
| `verified`          | `completed` | Required      | Validated against the ticket's stated aims; verification method recorded on the ticket.    |
| `canceled`          | `canceled`  | Required      | Abandoned. Not done; will not be done.                                                     |

**Required** — implementations MUST map at least one native state to this role.
**Recommended** — implementations SHOULD map a native state to this role; base
workflows degrade gracefully if absent. **Optional** — base workflows do not
require this role.

### Tagging rule

Every native tracker state MUST be assigned to exactly one group. It MAY be
assigned an optional default role and optional computed-role overrides (rules
driven by attached metadata such as assignee, linked PR state, close reason, or
labels).

Skills resolve mappings in this order: **team override → default mapping → error**.
If neither a team override nor a default mapping covers a native state, the skill
MUST surface an error rather than guess.

## Per-tracker default mappings

### Linear

| Native substate | Group       | Role                |
| --------------- | ----------- | ------------------- |
| Backlog         | `backlog`   | `backlog`           |
| TODO            | `unstarted` | `available`         |
| In Progress     | `started`   | `in-progress`       |
| In Review       | `started`   | `in-review`         |
| Finished        | `started`   | `finished`          |
| Delivered       | `started`   | `delivered`         |
| Done            | `completed` | `verified`          |
| Canceled        | `canceled`  | `canceled`          |

Linear's top-level groups (`Backlog`, `Unstarted`, `Started`, `Completed`,
`Canceled`) cannot be customized and map directly to the protocol's groups.
Teams that need `paused` or `awaiting-external` MUST add custom substates in
Linear's `Backlog` group and map them in a team override.

### GitHub Issues — bare

| Native state | Detected metadata                                              | Group       | Computed role |
| ------------ | -------------------------------------------------------------- | ----------- | ------------- |
| open         | Unassigned, no linked PR                                       | `unstarted` | `available`   |
| open         | Assigned to caller; no linked PR or PR is draft                | `started`   | `in-progress` |
| open         | Linked PR is non-draft and review-requested                    | `started`   | `in-review`   |
| open         | Linked PR is approved (not merged)                             | `started`   | `finished`    |
| open         | Linked PR is merged (issue not yet closed)                     | `started`   | `delivered`   |
| closed       | Close reason `completed` AND linked PR merged                  | `completed` | `verified`    |
| closed       | Close reason `not_planned`, OR closed with no linked PR        | `canceled`  | `canceled`    |

### GitHub Issues — Projects v2

If the issue is on a Project v2 with a Status field, the Status option name
takes precedence over the bare-issue rules above.

| Status option | Group       | Role                |
| ------------- | ----------- | ------------------- |
| Backlog       | `backlog`   | `backlog`           |
| Paused        | `backlog`   | `paused`            |
| Blocked       | `backlog`   | `awaiting-external` |
| Available     | `unstarted` | `available`         |
| In Progress   | `started`   | `in-progress`       |
| In Review     | `started`   | `in-review`         |
| Finished      | `started`   | `finished`          |
| Delivered     | `started`   | `delivered`         |
| Done          | `completed` | `verified`          |
| Canceled      | `canceled`  | `canceled`          |

If an issue is closed but its Project Status is not in the `completed` or
`canceled` groups, the bare-issue metadata rules apply.

### Asana

| Native (top-level / custom field) | Group       | Role                |
| --------------------------------- | ----------- | ------------------- |
| Incomplete / Backlogged           | `backlog`   | `backlog`           |
| Incomplete / Paused               | `backlog`   | `paused`            |
| Incomplete / Blocked              | `backlog`   | `awaiting-external` |
| Incomplete / Committed            | `unstarted` | `available`         |
| Incomplete / In Progress          | `started`   | `in-progress`       |
| Incomplete / In Review            | `started`   | `in-review`         |
| Complete (native or custom field) | `completed` | `verified`          |

When a task's custom field is set to Complete, Asana automation typically marks
the native task Complete simultaneously. These transitions MUST be treated as a
single atomic event mapping to `verified`.

The default Asana mapping has no `delivered`, `finished`, or `canceled` role; the
lifecycle collapses directly from `in-review` to `verified`. Teams that need any
of these roles MUST add custom-field options and map them in a team override.

### Cross-tracker note on `finished`

Only Linear and GitHub Projects v2 natively express `finished`; on other
trackers, skills MUST collapse to `in-review → delivered` and MUST NOT emit a
`finished` transition.

## State transitions

### Forward path

The recommended forward path is:

```text
available → in-progress → in-review → finished → delivered → verified
```

Trackers without `finished` use:

```text
available → in-progress → in-review → delivered → verified
```

### Corrective (backward) transitions

| From          | To            | Trigger                                                           |
| ------------- | ------------- | ----------------------------------------------------------------- |
| `in-review`   | `in-progress` | Review surfaced new work; returning to implementation.            |
| `finished`    | `in-review`   | A new review was requested or an approval was withdrawn.          |
| `finished`    | `in-progress` | New work surfaced after approval but before merge.                |
| `delivered`   | `in-progress` | Rollback or fix-forward required before verification.             |
| `verified`    | `in-progress` | Regression discovered after verification.                         |

A corrective transition MUST emit a state-change log entry (see §Operational
logging) with a non-empty rationale.

### Park transitions

A ticket in any `unstarted` or `started` role MAY transition to `paused` or
`awaiting-external` if the tracker supports those roles.

Resuming from a parked role MUST go to `available` first. Skills MUST NOT resume
directly to `in-progress` from a parked role.

### Cancellation

Any role except `verified` and `canceled` MAY transition to `canceled`. The
transition MUST emit a state-change log entry with a non-empty rationale.

### Forbidden transitions

- `canceled` → any role. A canceled ticket is terminal. If the work needs to be
  redone, file a new ticket.
- `verified` → `canceled`. If shipped work needs to be undone, use the corrective
  `verified → in-progress` transition.

Any transition not enumerated above is non-conforming.

### Multi-agent coordination

A ticket has at most one acting agent at a time, identified by tracker-side
assignment. An agent MUST NOT transition a ticket assigned to a different agent.
Reassignment from one agent to another SHOULD be logged as `INFO` (see §Operational
logging).

## Dependencies

### Effective-blocking rule

A ticket is **effectively blocked** if it has a dependency edge to any ancestor
whose role is not in `{verified, canceled}`. The relation is transitive: a ticket
is effectively blocked if **any** ancestor on **any** path is effectively
blocking.

Skills MUST evaluate the effective-blocking rule before treating a ticket as
eligible for work.

### Cycles

Dependency cycles are illegal. Skills MUST detect a cycle at write time when
adding a dependency edge and MUST refuse to create the edge with a clear error.
At read time, a skill walking the dependency graph and encountering a cycle MUST
surface an error.

### Self-blocking

A ticket MUST NOT depend on itself. Self-edges MUST be rejected at write time.

### Direction convention

The protocol's edge type is `blocks`: A `blocks` B means B depends on A. Skills
MUST emit dependencies in the form most natural to the tracker.

| Tracker       | Native mechanism                                      |
| ------------- | ----------------------------------------------------- |
| Linear        | First-class `blocks` / `blocked-by` relations         |
| GitHub Issues | Native `Blocked by` / `Blocking` issue dependencies   |
| Asana         | Native `dependent on` / `dependency for` relations    |

Cross-tracker dependencies are out of scope. A ticket on one tracker MUST NOT
depend on a ticket on another tracker.

## Milestones

### Membership

On most trackers, a ticket belongs to at most one milestone at a time. In Asana,
a task may belong to multiple projects and may therefore block multiple milestones
simultaneously — this is permitted and expected. On other trackers, where a
tracker permits multi-milestone assignment, the team config MUST elect a
primary-milestone field; implementations MUST use only that field and MUST treat
all others as informational.

### Ready for review

A milestone is **ready for review** when it has no remaining blockers: every
ticket in the milestone is in the `verified` or `canceled` group, and no
unresolved ticket (in any group other than `verified` or `canceled`) is a direct
or transitive dependency of any ticket in the milestone.

### Milestone review

When a milestone is ready for review, a milestone review MUST run before the
next milestone is started. The review answers two questions:

1. **Was the milestone goal achieved?**
2. **Is follow-up work needed?**

If the review determines follow-up work is needed, the reviewer MUST file those
tickets in the **current** milestone. Filing follow-up tickets in the current
milestone prevents transition to the next milestone. The implementation resumes
work on the follow-up tickets within the current milestone, and a new milestone
review runs once they are complete.

The review outcome MUST be recorded as a comment on the designated review
artifact (a Linear project update, a GitHub Milestone closure comment, or an
Asana milestone-task comment). Implementations dispatching work MUST verify that
the current milestone is both ready for review AND has a recorded review outcome
before advancing to the next milestone.

### Trackers without milestones

If no milestone mechanism is available, the protocol's milestone semantics do not
apply and implementations MUST treat the entire ticket pool as one implicit
milestone.

## Definition of Done

### Transition into `verified`

A transition into `verified` MUST be accompanied by a comment on the ticket that
records all three of the following:

1. **What was verified** — stated against the ticket's aims.
2. **How it was verified** — the concrete method (URL of the green build, the
   production request exercised, the rendered output, etc.).
3. **What was not verified** — intentionally deferred items that are out of scope
   for this ticket, each with a follow-up ticket already filed.

If any in-scope aim was not successfully verified, the ticket MUST NOT transition
to `verified`. It MUST instead return to `in-progress` with a comment explaining
what remains and what remediation is planned.

The comment MUST follow §2.1 (machine marker plus mode-appropriate visible marker).

### Multi-PR tickets

A ticket MAY require multiple PRs. The ticket MUST NOT transition to `delivered`
until all PRs needed to satisfy its aims are merged or deployed. Intermediate
PRs MUST NOT trigger a `delivered` transition.

### Verification failure

If the agent cannot produce evidence satisfying all three criteria above, or if
evidence already recorded is later determined to be invalid, the corrective
transition is `verified → in-progress`. The original verification artifact
comment MUST NOT be deleted or modified; a new corrective-transition comment
MUST explain what failed and what the remediation will be.

## Communication restriction

### The rule

Once an agent is explicitly assigned a tracked work item it MUST NOT solicit
responses through the session. All requests for human input MUST go through the
ticketing or source-control system per the routing rule below.

### Explicit assignment

An agent is explicitly assigned when any of the following holds:

- The ticket is assigned to the agent's identity.
- The PR is assigned or has a review requested from the agent's identity.
- The project's lead / owner is the agent's identity.
- A skill invocation explicitly names a tracked work item (e.g.
  `/work-on-ticket DEV-123`).

Sessions started without an assignment are not subject to the restriction.

### Prohibited while assigned

While assigned, an agent MUST NOT:

- Use any mechanism that solicits a session-level user response.
- Block on session input as a condition for forward progress.

### Permitted while assigned

While assigned, an agent MAY:

- Emit progress updates, status logs, and completion summaries to the session.
- Read proactive user input that arrives in the session. If that input
  substantively changes the work, the agent MUST echo its substance as a comment
  on the ticket or PR (not a verbatim transcript). Acknowledgements and routine
  clarifications without substance need not be echoed.

### Routing rule for requests for human input

When the agent needs human input it cannot resolve, it MUST route the request to
the first applicable venue in this order:

1. **PR** — if a pull request exists for the work, post a comment on the PR.
2. **Ticket** — otherwise, if a ticket exists, post a comment on the ticket.
3. **New ticket** — otherwise, open a ticket and post a comment on it.

In all three cases, the agent MUST tag at least one human in the comment. The
comment MUST follow §2.1. The work then enters a wait state, logged as `WAIT` per
§Operational logging. Monitoring of the chosen venue follows §2.1.2
§"Thread-aware filtering" until the request is resolved.

### Resolution

A request is resolved when a human responds with addressable content (an answer,
a directive, or an explicit decline). The agent MUST react per §2.1 (terminal
reaction or text token), resume work, emit a `RESUME` log entry, emit a
`TRANSITION` log entry if the response triggers a role change, and post a
follow-up comment summarizing the action taken if the response was substantive.

## Operational logging

### Session transcript format

Every log entry MUST be a single line in this format:

```text
<timestamp> <kind> ticket=<ticket-link> pr=<pr-link> ticket-role=<role> pr-state=<pr-state> | <message>
```

| Field           | Format                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------- |
| `<timestamp>`   | RFC 3339 with timezone offset, second precision                                               |
| `<kind>`        | One of: `TRANSITION`, `WAIT`, `RESUME`, `BLOCK`, `INFO`, `ERROR`                             |
| `<ticket-link>` | Full URL to the ticket. `-` if no ticket.                                                     |
| `<pr-link>`     | Full URL to the PR. `-` if no PR.                                                             |
| `<role>`        | The protocol role, e.g. `in-progress`. `-` if no ticket.                                     |
| `<pr-state>`    | `draft`, `open`, `shipped`, or `abandoned` (the resolved PR-status terminal; `shipped` covers any way the change lands in base, `abandoned` is closed-without-landing). `-` if no PR. |
| `<message>`     | Free text, one line. REQUIRED for `TRANSITION`, `WAIT`, `RESUME`, `BLOCK`, and `ERROR`.      |

`<kind>` semantics:

| Kind         | When to emit                                                                                |
| ------------ | ------------------------------------------------------------------------------------------- |
| `TRANSITION` | Whenever the agent transitions a ticket's role.                                             |
| `WAIT`       | When work transitions to awaiting a response or external condition.                         |
| `RESUME`     | When the awaited response arrives or condition is met and active work resumes.              |
| `BLOCK`      | When filing a new out-of-scope blocking ticket.                                             |
| `INFO`       | Substantive non-state-change events: subtask creation, reassignment, etc.                   |
| `ERROR`      | Tracker errors, verification failures, and any condition surfaced but not immediately fatal. |

The `ticket=` and `pr=` fields MUST be full URLs, never bare IDs.

### WAIT entries

A `WAIT` entry's message MUST identify the awaited venue and the awaited outcome.
The corresponding `RESUME` entry SHOULD reference the same venue.

### State-change comment (tracker echo)

When the agent transitions a ticket's role, it MUST post a comment to the primary
venue (PR if one exists, else ticket) with a body containing exactly these two
lines:

```text
State: <prev-role> → <new-role>
Rationale: <one-line rationale; required for corrective and cancel transitions>
```

The comment MUST follow §2.1 (machine marker, Mode B sparkle wrapper where
required).

## Decomposition rule

When the assigned ticket is too large for a single coherent unit of work, OR
cannot be completed without out-of-scope work, the agent MUST decompose.

**Too large** — the agent MUST file subtasks of the parent ticket using the
tracker's native subtask mechanism, and MUST operate on subtasks individually.
The parent ticket MUST remain in `in-progress` until all subtasks reach
`verified` or `canceled`. The subtask creation MUST be logged as `INFO`.

**Out-of-scope blocker** — the agent MUST file a new ticket for the blocker and
MUST link it as a `blocks` edge to the current ticket per §Dependencies. The
agent then switches to working on the blocker ticket (or another unblocked ticket
in the queue). When the blocker is resolved, the agent returns to the original
ticket. Tagging a human is required only when the blocker requires a human
decision that cannot be made autonomously. The parent ticket MAY remain in
`in-progress` if other non-blocked work remains, or MUST transition to
`awaiting-external` (or `paused` if unavailable) if all remaining work is
blocked. The blocker filing MUST be logged as `BLOCK`.
