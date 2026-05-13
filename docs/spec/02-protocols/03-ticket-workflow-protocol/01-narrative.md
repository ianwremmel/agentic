# §2.3.1 — Ticket Workflow Protocol: Narrative

## The tracker diversity problem

Ticketing systems disagree about state. GitHub Issues has two states (open /
closed). Linear has five top-level groups plus customizable substates. Asana has
two top-level states plus customizable custom-field options.

Without a shared abstraction, every skill branches on tracker type and hardcodes
state names — brittle and unportable. This protocol defines an abstract role
vocabulary that every supported tracker maps onto, so skills can ask "what's
available to pick up?" or "is this ticket blocked?" without caring which tracker
holds the data.

The protocol also codifies the operational norms any agent doing tracked work
must follow — the communication restriction, the log format, the decomposition
rule — so multiple agents collaborating on the same project produce a consistent
audit trail.

## Two-tier vocabulary: groups and roles

The vocabulary has two tiers.

**Groups** are coarse lifecycle stages — `backlog`, `unstarted`, `started`,
`completed`, `canceled`. Every native tracker state maps to exactly one group.
Groups answer the coarsest lifecycle questions: "has this work started?" "is it
done?"

**Roles** are refinements within a group. They answer finer questions: "is this
in code review or waiting on CI?" "has it been deployed but not yet verified?"
Skills that need precision use roles; skills doing broad dispatch can use groups
alone.

### Why `paused` and `awaiting-external` sit in `backlog`

Both involve work that was previously started but is not currently progressing.
That might seem like they belong in `started`, but from a dispatching agent's
perspective the lifecycle question is "is this ticket currently moving?" — both
states answer no. Placing them in `backlog` keeps the dispatching logic simple:
anything not in `started` is not currently in flight.

Prior history is preserved in the tracker's transition log; the protocol doesn't
need to encode it as state.

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
define its own milestone primitive — it consumes whatever the tracker provides
(Linear Project, GitHub Milestone, Asana Section).

A milestone is **structurally complete** when every ticket is in `verified` or
`canceled`. Structural completion is a precondition for review, not a synonym for
done: a milestone review must still run before the team advances to the next
milestone. The review answers whether the milestone goal was achieved and whether
follow-up work needs scheduling.

## Definition of Done

`verified` means the change was validated against the aims stated on the ticket.
The method is content-specific:

- A CI change is verified when the default branch's CI passes after merge.
- A production code change is verified by exercising it in production.
- A documentation change is verified by checking the rendered output.
- A refactor is verified by confirming no behavioral regressions.

A transition into `verified` must be accompanied by a comment recording what was
verified, how it was verified, and what (if anything) was not. This artifact is
the audit trail; verification failures don't erase it, they add to it.

## Communication restriction

Once an agent is assigned a tracked work item it stops soliciting responses
through the session. All requests for human input go through the ticket or PR
instead. The rule exists to keep the audit trail in the tracker, not scattered
across sessions that may not be observable by other agents or team members.

When the agent genuinely needs human input it can't resolve, it posts a comment
on the PR (if one exists), the ticket (if a PR doesn't exist), or opens a new
ticket. It tags a human so the platform notifies them, then waits.

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
be completed without out-of-scope work, the agent decomposes rather than
stretching the ticket:

- **Too large** — file subtasks linked as children, work on them individually.
  The parent stays in `in-progress` until all subtasks finish.
- **Out-of-scope blocker** — file a new ticket for the blocker, link it as a
  `blocks` edge, and tag a human. The parent either stays in `in-progress` (if
  other work remains) or parks in `awaiting-external`.

Both cases are logged (`BLOCK` for an out-of-scope blocker, `INFO` for subtask
creation) so the event is traceable.
