# §2.3.1 — Ticket Workflow Protocol: Narrative

## The tracker diversity problem

Ticketing systems disagree about state. GitHub Issues has two states (open /
closed). Linear has five top-level groups plus customizable substates. Asana has
two top-level states plus customizable custom-field options.

Without a shared abstraction, every agent or tool branches on tracker type and
hardcodes state names — brittle and unportable. This protocol defines an abstract
role vocabulary that every supported tracker maps onto, so implementations can
ask "what's available to pick up?" or "is this ticket blocked?" without caring
which tracker holds the data.

The protocol also codifies the operational norms any implementation doing tracked
work must follow — the communication restriction, the log format, the
decomposition rule — so multiple agents collaborating on the same project produce
a consistent audit trail.

## Two-tier vocabulary: groups and roles

The vocabulary has two tiers.

**Groups** are coarse lifecycle stages — `backlog`, `unstarted`, `started`,
`completed`, `canceled`. Every native tracker state maps to exactly one group.
Groups answer the coarsest lifecycle questions: "has this work started?" "is it
done?"

**Roles** are refinements within a group. They answer finer questions: "is this
in code review or waiting on CI?" "has it been deployed but not yet verified?"
Implementations that need precision use roles; those doing broad dispatch can use
groups alone.

### Why `paused` and `awaiting-external` sit in `backlog`

Both involve work that was previously started but is not currently progressing.
From a dispatching perspective the question is "is this ticket currently moving?"
— both states answer no. Placing them in `backlog` keeps the dispatching logic
simple: anything not in `started` is not currently in flight.

## State machine

The forward path through a ticket's lifecycle is:

```
available → in-progress → in-review → finished → delivered → verified
```

Trackers without a `finished` role (Asana, GitHub bare) collapse the
`in-review → finished → delivered` sequence into `in-review → delivered`.

The protocol also permits corrective (backward) transitions — for example,
`in-review → in-progress` when review surfaces new work. These are always logged
with a rationale. Park transitions (`in-progress → paused`) and cancellation are
also enumerated; anything outside the enumerated set is non-conforming.

## Dependencies

A ticket is **effectively blocked** when any ancestor on any path is not yet in
`completed` or `canceled`. The relation is transitive: a long chain where only
one ticket in the middle is still `in-progress` blocks everything downstream.

Cycles are illegal and must be detected at write time. Cross-tracker dependencies
are out of scope; a work item on one tracker cannot block a work item on another.

## Milestones

A milestone groups tickets with a shared completion goal. The protocol doesn't
define its own milestone primitive — it consumes whatever the tracker provides.
In Linear, milestones are tracked within a Project (Linear Projects *have*
Milestones; a Project is not itself a milestone). GitHub has a native Milestone
feature on repositories. In Asana, a Milestone is a special task type, distinct
from regular tasks and from Projects (which organize tasks but are not milestones
themselves).

A milestone is **ready for review** when it has no remaining blockers: every
ticket in the milestone is in `verified` or `canceled`, and no unresolved ticket
blocks any milestone ticket. A milestone review must run before the team
advances, even when structurally complete. The review answers whether the
milestone goal was achieved and whether follow-up work needs scheduling.

## Definition of Done

`verified` means the change was validated against the aims stated on the ticket.
Most tickets have acceptance criteria that can be evaluated directly; the examples
below are illustrative, not exhaustive:

- A CI change is verified when the default branch's CI passes after merge.
- A production code change is verified by exercising it in production.
- A documentation change is verified by checking the rendered output.
- A refactor is verified by confirming no behavioral regressions.

The key principle: simply merging code does not constitute verification. Every
ticket's stated aims must be evaluated, not just its associated PR merged. A
transition into `verified` must be accompanied by a comment recording what was
verified, how it was verified, and what (if anything) was not. This artifact is
the audit trail; verification failures don't erase it, they add to it.

## Communication restriction

Once an implementation is assigned a tracked work item it stops soliciting
responses through the session. All requests for human input go through the ticket
or PR instead. The rule exists to keep the audit trail in the tracker, not
scattered across sessions that may not be observable by other agents or team
members.

When input is genuinely needed, post a comment on the PR (if one exists), the
ticket (if a PR doesn't exist), or open a new ticket. Tag a human so the platform
notifies them, then wait.

Sessions started without an assignment — interactive scoping, exploratory
questions, ad-hoc analysis — are not subject to the restriction.

## Operational logging

Every log entry lands on the session transcript. State-change entries are also
echoed as comments on the primary venue (PR or ticket) so the tracker retains a
readable history of what happened and why.

The session transcript format is a structured one-liner:

```
2026-05-09T14:23:01-04:00 TRANSITION ticket=https://linear.app/… pr=https://github.com/… ticket-role=in-review pr-state=open | review requested from Copilot
```

The `WAIT` / `RESUME` pair lets anyone grep the session to find how long a
particular wait lasted:

```
2026-05-09T14:31:00-04:00 WAIT   ticket=… pr=… ticket-role=in-review pr-state=open | awaiting human reply on PR comment #2 (scope question)
2026-05-09T15:10:44-04:00 RESUME ticket=… pr=… ticket-role=in-review pr-state=open | scope question resolved
```

The state-change comment posted to the tracker echoes the transition in
structured form so humans can read it at a glance:

```
<!-- agent-reply:dispatch -->
✨

State: in-progress → in-review
Rationale: implementation complete, requesting review

✨
```

## Decomposition

When assigned work turns out to be larger than a single coherent unit, or cannot
be completed without out-of-scope work, the implementation decomposes rather than
stretching the ticket:

- **Too large** — file subtasks linked as children, work on them individually.
  The parent stays in `in-progress` until all subtasks finish.
- **Out-of-scope blocker** — file a new ticket for the blocker and link it as a
  `blocks` edge to the current ticket. The implementation works on the blocker
  (or switches to another unblocked ticket), then returns to the original once
  the blocker is resolved. Tagging a human is appropriate when the blocker
  requires a human decision.

Both cases are logged (`BLOCK` for an out-of-scope blocker, `INFO` for subtask
creation) so the event is traceable.
