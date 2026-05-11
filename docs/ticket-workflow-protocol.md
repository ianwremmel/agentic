# Ticket Workflow Protocol

This document defines the on-the-wire vocabulary and semantics that
any agent and any tool MUST share when coordinating tracked work
across PRs and tickets. It is a protocol specification, not an
implementation guide: it describes what writers emit, what readers
accept, and what the abstract states mean across trackers, but stays
silent on skill choreography, the agent's operational driver, and
similar concerns.

Read alongside `agent-communication-protocol.md` (how to write into
a comment stream) and `pr-status-protocol.md` (how to read PR
state). Those two protocols stay authoritative for their concerns;
this one references them rather than duplicating.

## Why this exists

Ticketing systems disagree about state. GitHub Issues has two
states (open / closed). Linear has five top-level groups (backlog,
unstarted, started, completed, canceled) plus customizable
substates. Asana has two top-level states (incomplete / complete)
plus customizable custom-field options. Without a shared
abstraction, every skill ends up branching on tracker type and
hardcoding state names — brittle and unportable.

This protocol defines an abstract role vocabulary that every
supported tracker maps onto, so skills can reason about "what's
available for me to start?" or "is this ticket effectively
blocked?" without caring which tracker holds the data. It also
codifies the operational norms that any agent doing tracked work
MUST follow — the communication restriction, the log format,
the decomposition rule — so multiple agents collaborating on the
same project produce a uniform audit trail.

## Scope

The protocol covers:

- the abstract role / group vocabulary
- per-tracker default mappings between native states and the
  abstract vocabulary
- legal state transitions and the rules around corrective and
  cancel transitions
- dependency semantics, including effective-blocking
- milestone semantics, including structural completion and the
  review-before-advance rule
- definition-of-done semantics, including the verification artifact
- the agent-side communication restriction once assigned, and the
  routing rule for human input
- operational norms: log line format, state-change comment format,
  and the decomposition rule

It does not cover:

- skill choreography (which states to transition through in which
  order, how to verify, how to run a milestone review)
- the storage location for team override mappings (an
  implementation concern of the consuming plugin)
- the agent's operational driver (daemon, polling loop, event
  handler, etc.)

## Roles and groups

Two-tier vocabulary: **groups** (coarse lifecycle stages, one
mandatory tag per state) and **roles** (refinements within a
group, optionally computed from attached metadata).

### Groups

| Group       | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `backlog`   | Not currently progressing; not eligible to be picked up. |
| `unstarted` | Ready to be picked up.                                   |
| `started`   | Work is in flight.                                       |
| `completed` | Work is done.                                            |
| `canceled`  | Work was abandoned without completion.                   |

### Roles

| Role                | Group       | Required-ness | Description                                                                              |
| ------------------- | ----------- | ------------- | ---------------------------------------------------------------------------------------- |
| `backlog`           | `backlog`   | Optional      | Not yet ready to work on; promoted to `available` when ready.                            |
| `paused`            | `backlog`   | Optional      | Started but temporarily stopped due to other priorities.                                 |
| `awaiting-external` | `backlog`   | Optional      | Cannot proceed until an external condition is met (other team's deploy, contract, etc.). |
| `available`         | `unstarted` | Required      | Eligible to be picked up by an unblocked agent.                                          |
| `in-progress`       | `started`   | Required      | An agent is actively working on this ticket.                                             |
| `in-review`         | `started`   | Recommended   | Primary work complete; iterating with reviewers (including Copilot).                     |
| `finished`          | `started`   | Optional      | Review complete; approved but not yet merged or deployed.                                |
| `delivered`         | `started`   | Recommended   | Merged or deployed but not yet verified.                                                 |
| `verified`          | `completed` | Required      | Validated against its stated aims; verification method recorded on the ticket.           |
| `canceled`          | `canceled`  | Required      | Abandoned. Not done; will not be done.                                                   |

**Required** = a tracker mapping MUST tag at least one native state
with this role. **Recommended** = ought to exist for full skill
capability; skills degrade gracefully if missing. **Optional** =
refinement; base workflows do not rely on it.

### Note on `paused` and `awaiting-external`

Both sit in the `backlog` group even though work was previously
started. From the dispatching agent's perspective, the lifecycle
question is "is this currently progressing?" — both states answer
no. Returning to active work moves the ticket back through
`available` → `in-progress`. Skills that care about prior history
can read the tracker's transition log; the protocol does not
encode it as state.

### Tagging rule

A team using this protocol relies on a mapping that assigns each
native state in their tracker to exactly one **group**, plus an
optional **default role** and optional computed-role overrides
(rules driven by attached metadata — assignee, linked PR state,
close reason, labels).

This protocol ships **default mappings** in the next section
covering Linear (state-name convention), GitHub Issues (bare and
Projects v2), and Asana (custom-field convention). Teams whose
tracker configuration matches a default may rely on it as-is.
Teams with non-standard configurations MUST publish a
tracker-specific override. Skills resolve mappings as `team
override → shipped default`; if neither covers a state, the skill
MUST surface an error rather than guess. The protocol does not
prescribe the storage location for team overrides — that is an
implementation concern of the consuming plugin.

## Per-tracker default mappings

### Linear

Linear's top-level groups (`Backlog`, `Unstarted`, `Started`,
`Completed`, `Canceled`) cannot be customized and map directly to
the protocol's groups. The default mapping below assumes the team
uses these substate names.

| Native substate | Group       | Role          |
| --------------- | ----------- | ------------- |
| Backlog         | `backlog`   | `backlog`     |
| TODO            | `unstarted` | `available`   |
| In Progress     | `started`   | `in-progress` |
| In Review       | `started`   | `in-review`   |
| Finished        | `started`   | `finished`    |
| Delivered       | `started`   | `delivered`   |
| Done            | `completed` | `verified`    |
| Canceled        | `canceled`  | `canceled`    |

Linear has no native `paused` or `awaiting-external`. Teams that
need them add custom substates in the `Backlog` top-level group
and map them in an override.

### GitHub Issues — bare

GitHub Issues without a Project has only `open` / `closed`. The
default mapping uses metadata to compute a refined role, since one
native state covers many lifecycle stages.

| Native state | Detected metadata                                           | Group       | Computed role |
| ------------ | ----------------------------------------------------------- | ----------- | ------------- |
| open         | unassigned, no linked PR                                    | `unstarted` | `available`   |
| open         | assigned to caller, no linked PR or PR is draft             | `started`   | `in-progress` |
| open         | linked PR is non-draft and review-requested                 | `started`   | `in-review`   |
| open         | linked PR is approved (review state `approved`, not merged) | `started`   | `finished`    |
| open         | linked PR is merged (issue not yet closed)                  | `started`   | `delivered`   |
| closed       | close reason `completed` AND linked PR merged               | `completed` | `verified`    |
| closed       | close reason `not_planned`, OR closed with no linked PR     | `canceled`  | `canceled`    |

GitHub bare has no representation for `backlog`, `paused`, or
`awaiting-external`. Teams that need those use Projects v2 (next
subsection) or a label convention in an override.

### GitHub Issues — Projects v2

If the issue is on a Project v2 with a Status field, the Status
option name takes precedence over the bare-issue rules above. The
default mapping assumes a Status field with these named options.

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

If the issue is closed but its Project Status is not in
`completed` / `canceled`, the closed-state metadata rules from the
bare mapping apply. This catches issues closed without updating
the project field.

### Asana

Default mapping assumes a custom-field setup with substates inside
Asana's native `Incomplete` state.

| Native (top-level / custom field) | Group       | Role                |
| --------------------------------- | ----------- | ------------------- |
| Incomplete / Backlogged           | `backlog`   | `backlog`           |
| Incomplete / Paused               | `backlog`   | `paused`            |
| Incomplete / Blocked              | `backlog`   | `awaiting-external` |
| Incomplete / Committed            | `unstarted` | `available`         |
| Incomplete / In Progress          | `started`   | `in-progress`       |
| Incomplete / In Review            | `started`   | `in-review`         |
| Incomplete / Complete             | `started`   | `delivered`         |
| Complete (top-level)              | `completed` | `verified`          |

Asana has no `finished` role and no native `canceled`. Teams that
need those add custom-field options and map them in an override;
common conventions are an `Approved` custom-field option for
`finished` and a `Won't Do` option (or a `canceled` label) for
`canceled`.

### Cross-tracker note on `finished`

Only Linear and GitHub-Projects natively express `finished`
(review approved but not merged). On other trackers, skills MUST
treat the absence of `finished` as "this tracker collapses
approval and merge into one transition," and emit only the
`delivered` transition — not both.

## State transitions

The protocol defines a recommended forward path and an enumerated
set of permitted corrective transitions. Anything not enumerated
is non-conforming.

### Recommended forward path

```
backlog → available → in-progress → in-review → finished → delivered → verified
```

Trackers without `finished` (Asana, GitHub bare) collapse
`in-review → finished → delivered` into `in-review → delivered`.

### Permitted corrective (backward) transitions

| From        | To            | Trigger                                                  |
| ----------- | ------------- | -------------------------------------------------------- |
| `in-review` | `in-progress` | Review surfaced new work; back to implementation.        |
| `finished`  | `in-review`   | A new review was requested or an approval was withdrawn. |
| `finished`  | `in-progress` | New work surfaced after approval but before merge.       |
| `delivered` | `in-progress` | Rollback or fix-forward needed before verification.      |
| `verified`  | `in-progress` | Regression discovered after verification (a "reopen").   |

A corrective transition MUST emit a state-change log entry per
"Operational logging" with a non-empty rationale.

### Permitted park transitions

A ticket in any `unstarted` or `started` role MAY transition to
`paused` or `awaiting-external` if the tracker supports it.
Resuming from a parked role MUST go to `available` first; the
agent then re-picks the ticket through the normal forward path.
Skills MUST NOT resume directly to `in-progress` from a parked
role — going through `available` is what surfaces the resume to
dispatching agents.

### Permitted cancellation

Any role except `verified` and `canceled` MAY transition to
`canceled`. The transition MUST emit a state-change log entry with
a non-empty rationale. Canceling shipped work (`verified`) is
forbidden — see "Forbidden transitions" below for the corrective
to use instead.

### Forbidden transitions

- `canceled` → anything. A canceled ticket is terminal. If the
  work needs to be redone, file a new ticket and link it.
- `verified` → `canceled`. The work shipped; canceling it
  after-the-fact is not a meaningful state. If shipped work needs
  to be undone, the corrective is `verified → in-progress`
  (rollback / fix-forward), then the new work flows through
  normally.

### Authorization

Authorization for a transition is the tracker's concern; the
protocol does not duplicate it. The protocol's only requirement
is that any transition initiated by an agent emit a state-change
log entry per "Operational logging," regardless of direction.

### Multi-agent coordination

A ticket has at most one acting agent at a time, identified by
tracker-side assignment. An agent MUST NOT transition a ticket
assigned to a different agent. Reassigning a ticket from one agent
to another is itself a non-state-changing event but SHOULD be
logged as `INFO` per "Operational logging."

## Dependencies

### Effective-blocking rule

A ticket is **effectively blocked** if it has a dependency edge
to any ancestor ticket whose role is in the set
`{backlog, paused, awaiting-external, available, in-progress,
in-review, finished, delivered}` — i.e., any role outside
`completed` and `canceled`. Edges to ancestors in `verified` or
`canceled` do not contribute to blocking.

The relation is transitive: a ticket is effectively blocked if
**any** ancestor on **any** path is effectively blocking.

```
A (verified)        ─ does not block
   └─> B            ─ effectively unblocked unless other edges block
A (canceled)        ─ does not block
A (paused)          ─ blocks
A (in-progress)     ─ blocks
A (awaiting-ext)    ─ blocks
A (verified) → B (in-progress) → C
                    ─ C is blocked: A doesn't, but B does
```

### Cycles

Dependency cycles are illegal. Skills MUST detect cycles at write
time (when adding an edge) and refuse to create the edge with a
clear error. Detection at read time is also required: an agent
walking the dependency graph and finding a cycle MUST surface it
as an error rather than infinite-loop or silently break it.

### Self-blocking

A ticket MUST NOT depend on itself. Self-edges are a degenerate
cycle and MUST be rejected at write time.

### Direction convention

The protocol's edge type is `blocks`: A `blocks` B means B depends
on A. The inverse, `blocked-by`, is the same edge read in reverse.
Skills emitting a dependency MUST emit it in the form most natural
to the tracker (Linear and Asana use both; GitHub Issues uses
native `Blocking` / `Blocked by`). The semantic is symmetric; the
wire representation is per-tracker.

### Per-tracker default mappings

| Tracker       | Native mechanism                                     |
| ------------- | ---------------------------------------------------- |
| Linear        | First-class `blocks` / `blocked-by` relations        |
| GitHub Issues | Native issue dependencies (`Blocked by` / `Blocking`)|
| Asana         | Native `dependent on` / `dependency for` relations   |

Trackers without a native dependency mechanism are out of scope
for this protocol; teams using such trackers must either add a
native mechanism or extend the protocol with a per-team override.

### Cross-system dependencies

Out of scope. A ticket on tracker A MUST NOT depend on a ticket on
tracker B. If a body of work spans trackers, surface the
dependency as a project-level coordination concern (a skill
suite's responsibility), not as a tracker-side edge.

## Milestones

### What a milestone is

A milestone is a tracker-defined grouping of tickets with a shared
completion goal. Milestones are first-class on every supported
tracker (Linear `Milestone` / `Project`, GitHub `Milestone`, Asana
`Section` / `Project`). The protocol does not define its own
milestone primitive; it consumes whatever the tracker provides.

### Membership

A ticket belongs to at most one milestone at a time. The protocol
does not support multi-milestone tickets — if a tracker permits
them, the team config MUST elect a primary-milestone field for the
protocol to consult, and skills MUST surface the others as
informational only.

### Structural completion

A milestone is **structurally complete** when every ticket in it
is in the `completed` group (`verified`) or the `canceled` group
(`canceled`). Tickets in any other group leave the milestone
structurally incomplete.

Structural completion is a precondition for review, not a synonym
for "done."

### Milestone review

When a milestone reaches structural completion, a milestone review
SHOULD run before the next milestone is started. The review
answers two questions:

1. **Was the milestone goal achieved?** If not, the reviewer files
   additional tickets into the milestone and the milestone reverts
   to structurally incomplete (one or more new tickets in
   `available` or earlier).
2. **Was follow-up work scheduled?** If yes, the reviewer files
   those tickets in the appropriate milestone (current or future)
   and links them.

The review's outcome MUST be recorded as a comment on a designated
review artifact: a Linear project update, a GitHub Milestone
closure comment, or an Asana milestone-task comment, depending on
tracker. The protocol does not prescribe the comment format
beyond the operational logging rules below.

### Sequencing

This protocol does not encode a global milestone order — that is
a project-management concern. It does require that **a milestone
whose review has not run is not considered done**, even if
structurally complete. Skills dispatching work MUST check both
structural completion and review-completion before advancing to a
next milestone.

### Trackers without milestones

Some tracker configurations lack milestones. In that case, the
protocol's milestone semantics simply do not apply — skills treat
the entire pool of tickets as one implicit milestone. The
protocol does not require milestones to be present.

## Definition of Done

### What `verified` means

The `verified` role asserts that the change has been validated
against the aims stated on the ticket. Validation is
content-specific:

- A CI change is verified by confirming the default branch's CI
  passes after merge.
- A production code change is verified by exercising it against
  production.
- A documentation change is verified by checking the rendered
  output reflects the intended content.
- A purely-internal refactor is verified by confirming no
  behavioral regressions in the affected paths.

The protocol does not enumerate verification methods exhaustively.
Skills choose the method appropriate to the ticket's content.

### Verification artifact

A transition into `verified` MUST be accompanied by a comment on
the ticket that records:

1. **What was verified** — restated against the ticket's stated
   aims.
2. **How it was verified** — the concrete method used (URL of the
   green default-branch build, prod request that was exercised,
   rendered output, etc.).
3. **What was not verified** — any aim of the ticket this
   verification step did not cover, with links to follow-up
   tickets if applicable.

The comment MUST follow `agent-communication-protocol.md` (machine
marker plus mode-appropriate visible marker). The protocol does
not prescribe the body format beyond the three required fields
above.

### Multi-PR tickets

A single ticket MAY require multiple PRs. The ticket MUST NOT
transition to `delivered` until all PRs needed to satisfy its aims
are merged or deployed. Intermediate PRs do not trigger a
`delivered` transition; the agent owning the ticket holds it in
`in-progress` or `in-review` across the multi-PR sequence.

Skills MAY use a checklist on the ticket to track outstanding PRs.
The protocol does not prescribe the checklist format.

### Verification failure

If verification fails after a transition to `verified`, the
corrective transition is `verified → in-progress` per "State
transitions." The verification artifact comment MUST be retained —
verification failures are diagnostic data, not redactable
mistakes. The corrective comment posted with the backward
transition explains what went wrong and what the remediation will
be.

### Who verifies

The protocol is silent on who performs verification.
Self-verification by the implementing agent is permitted; the
verification artifact is the audit trail. Skills MAY require
independent verification by policy, but the protocol does not.

## Communication restriction

### The rule

Once an agent is **explicitly assigned** a tracked work item — a
project, ticket, or pull request — that agent MUST NOT solicit
responses through the session. All requests for human input MUST
go through the ticketing or source-control system per the routing
rule below.

### What "explicitly assigned" means

The trigger is observable from the tracker:

- A ticket assigned to the agent's identity, OR
- A pull request assigned (or with a review requested from) the
  agent's identity, OR
- A project whose lead / owner is the agent's identity, OR
- A skill invocation that explicitly names a tracked work item to
  operate on (e.g. `/work-on-ticket DEV-123`).

In any of these cases, the agent is "assigned" for the duration of
its work on that item. Sessions started without an assignment —
interactive scoping, exploratory questions, ad-hoc analysis — are
not subject to the restriction; the agent may use the session
normally.

### What is prohibited

While assigned, the agent MUST NOT:

- Use any mechanism that solicits a session-level user response
  (e.g. `AskUserQuestion`, plan-mode approval prompts framed as
  questions, plain-text "should I…?" queries).
- Block on session input as a condition for forward progress.

### What is permitted

While assigned, the agent MAY:

- Emit progress updates, status logs, and completion summaries to
  the session per "Operational logging."
- Read proactive user input that arrives in the session. If that
  input substantively changes the work, the agent MUST echo the
  substance back into the ticket or PR comment stream (with a
  short summary, not verbatim transcript) so the audit trail
  remains in the tracker. Acknowledgements and routine
  clarifications without substance need not be echoed.

### Routing rule for requests for human input

When the agent needs human input it cannot resolve, it routes the
request to the first venue that exists, in this precedence order:

1. **PR** — if a pull request exists for the work, comment on the
   PR.
2. **Ticket** — else, if a ticket exists, comment on the ticket.
3. **New ticket** — else, open a ticket and comment on it.

In all three cases, the agent MUST tag at least one human in the
comment so the platform notifies them. The comment MUST follow
`agent-communication-protocol.md` (machine marker plus
mode-appropriate visible marker). The work then enters a wait
state, logged per "Operational logging" (`WAIT`); monitoring of
the chosen venue follows the read-side rules of
`agent-communication-protocol.md` until the request is resolved.

### Resolution

A request is resolved when a human responds in the venue with
addressable content (an answer, a directive, or an explicit
decline). The agent MUST react to the response per
`agent-communication-protocol.md` (terminal reaction or text
token), resume work, post a state-change log per "Operational
logging" if the response triggers a transition, and post a
follow-up comment summarizing the action taken if the response was
substantive.

### Boundary with the read-side protocol

Detection of "is this thread actionable?" follows
`agent-communication-protocol.md` §"Thread-aware filtering"
verbatim. This protocol adds no new actionability rules; it only
specifies where new requests are written and how responses are
awaited.

## Operational logging

### Where logs go

Every operational log entry has a primary venue and an optional
tracker echo:

- **Session transcript** (always). Every log entry lands here.
  Parseable by anyone tailing the session.
- **Ticket or PR comment** (state changes only). When a state
  change occurs, the agent posts an additional comment on the
  primary venue (PR if one exists, else ticket) summarizing the
  transition. Other log kinds are NOT echoed to the tracker; that
  would spam.

### Line format (session transcript)

Every log entry on the session transcript MUST be a single line in
this format:

```
<timestamp> <kind> ticket=<ticket-link> pr=<pr-link> ticket-role=<role> pr-state=<pr-state> | <message>
```

Field semantics:

| Field           | Format                                                                            |
| --------------- | --------------------------------------------------------------------------------- |
| `<timestamp>`   | RFC 3339 / ISO 8601 with timezone offset, second precision                        |
| `<kind>`        | One of: `TRANSITION`, `WAIT`, `RESUME`, `BLOCK`, `INFO`, `ERROR`                  |
| `<ticket-link>` | Full URL to the ticket. `-` if no ticket assigned to this work.                   |
| `<pr-link>`     | Full URL to the PR. `-` if no PR exists yet.                                      |
| `<role>`        | The protocol role, e.g. `in-progress`, `in-review`. `-` if no ticket.             |
| `<pr-state>`    | `draft`, `open`, `merged`, `closed`. `-` if no PR.                                |
| `<message>`     | Free text. Brief; one line. Required for `TRANSITION`, `WAIT`, `RESUME`, `BLOCK`, `ERROR`. |

`<kind>` semantics:

| Kind         | When to emit                                                                       |
| ------------ | ---------------------------------------------------------------------------------- |
| `TRANSITION` | Whenever the agent transitions a ticket's role.                                    |
| `WAIT`       | When the work transitions to awaiting a response or external condition.            |
| `RESUME`     | When the awaited response arrives or condition is met and active work resumes.     |
| `BLOCK`      | When filing a new blocking ticket because work is out of scope.                    |
| `INFO`       | Substantive non-state-change events: subtask creation, reassignment, etc.          |
| `ERROR`      | Tracker errors, verification failures, and any condition the agent surfaces but does not immediately fail on. |

The `ticket=` field MUST always be a clickable link, never a bare
ID. This satisfies the rule "never reference a ticket id, ticket
name, pr id, or pr name without making it a link."

Example:

```
2026-05-09T14:23:01-04:00 TRANSITION ticket=https://linear.app/foo/issue/DEV-123 pr=https://github.com/o/r/pull/42 ticket-role=in-review pr-state=open | review requested from Copilot
```

### WAIT entries

A `WAIT` entry's message MUST include the awaited venue and the
awaited outcome:

```
2026-05-09T14:31:00-04:00 WAIT ticket=… pr=… ticket-role=in-review pr-state=open | awaiting human reply on PR comment thread #2 (scope question)
```

The corresponding `RESUME` entry SHOULD reference the same venue
so the wait/resume pair is greppable.

### State-change comment format (tracker echo)

When the agent transitions a ticket's role, it posts a comment to
the primary venue (PR if one exists, else ticket) whose body
contains exactly these two lines:

```
State: <prev-role> → <new-role>
Rationale: <one-line rationale; required for corrective and cancel transitions>
```

The body is then framed per `agent-communication-protocol.md`: the
machine marker MUST precede the body, and in Mode B the body MUST
be wrapped in the sparkle block exactly as that protocol specifies.
A complete Mode B example:

```
<!-- agent-reply:dispatch -->
✨

State: in-progress → in-review
Rationale: implementation complete, requesting review

✨
```

The two-line body is the only addition this protocol makes to the
comment format.

### Decomposition rule

When the agent identifies that the assigned ticket is too large
for a single coherent unit of work, OR cannot be completed without
out-of-scope work, it MUST decompose:

- **Too large** — file subtasks of the parent ticket, link them as
  children / subtasks per the tracker's native mechanism, and
  operate on the subtasks individually. The parent ticket remains
  in `in-progress` until all subtasks reach `verified` or
  `canceled`.
- **Out-of-scope blocker** — file a new ticket capturing the
  blocker, link it as a `blocks` edge to the current ticket per
  "Dependencies," and tag a human. The parent ticket MAY remain in
  `in-progress` (the agent continues other parallel work) OR
  transition to `awaiting-external` (or `paused` if the tracker
  lacks `awaiting-external`) if no progress can be made without
  the blocker. The choice is at the agent's discretion based on
  whether non-blocked work remains.

The decomposition step MUST be logged as a `BLOCK` (out-of-scope
blocker) or `INFO` (subtask creation) entry per the line format
above.
