# §2.5.1 — Ticket Coordination Protocol: Narrative

## Why a coordination layer

The Ticket Workflow Protocol (§2.3) governs a ticket's lifecycle vocabulary. The
Delivery Protocol (§2.4) governs a single pull request from first commit to
merge. Neither owns the gap between them: **a ticket is not the same thing as a
PR.**

A ticket may need no PR (a verification gate, a human-only decision), one PR (the
common case), or several PRs (§2.3's multi-PR rule — the ticket must not reach
`delivered` until every PR needed to satisfy its aims has landed). Something has
to own the *ticket* while delegating each unit of code change to Delivery, apply
the §2.3 role transitions as those PRs progress, decompose the ticket when it is
too large or blocked, and decide when the ticket's stated aims are actually
verified.

That owner is the **coordinator**. One coordinator is responsible for exactly one
tracked work item — usually a ticket, but also a no-PR verification or a single
injected PR (which may have no ticket at all). It is the bridge between §2.3 (the
ticket) and §2.4 (the change), and it is the unit the Orchestration Protocol (§2.6)
dispatches. In fact the orchestrator routes **every** kind of work through a
coordinator, so the coordinator is where each kind is actually carried out and the
orchestrator itself stays kind-agnostic.

## What the coordinator owns

- **Its own brief.** A coordinator is handed only a ticket *identifier and URL*.
  It fetches the ticket's description, acceptance criteria, and links itself. A
  caller never passes the ticket body in — keeping callers (the orchestrator,
  or a human invoking the skill directly) thin and ignorant of ticket detail.
- **Decomposition.** When the ticket is too large for one coherent change, or
  cannot be completed without out-of-scope work, the coordinator decomposes per
  §2.3: subtasks for size, a new `blocks`-linked ticket for an out-of-scope
  blocker.
- **One or more PRs.** For each unit of work the coordinator drives a PR to a
  terminal state through §2.4 Delivery. Single-PR is the common case; multi-PR is
  the general one. PRs run sequentially by default — small PRs review faster, and
  one active build at a time keeps the coordinator's draw on the shared
  compute budget (§2.6) minimal — but a ticket whose work genuinely
  parallelizes MAY register several PR items at once, each dispatched under its
  own claim as capacity allows.
- **The ticket's role.** As its PRs progress, the coordinator transitions the
  ticket through the §2.3 roles (`in-progress` → `in-review` → `delivered` →
  `verified`), emitting the state-change comment and log entries §2.3 requires.
- **Definition of done.** The coordinator decides when the ticket is *verified*
  against its aims (not merely when a PR merged) and posts the §2.3 verification
  artifact (what / how / what-not).

## What the coordinator does NOT own

It does not own the PR lifecycle — Delivery (§2.4) does. It does not own the
graph, ranking, the global parallelism policy (`MAX_PARALLEL`), or dispatch —
the orchestrator (§2.6) does, and the coordinator does not reason over the whole
graph; its own claim is granted and released for it.
It MAY, though, read context from its **immediate** dependency neighbors — its
direct predecessors (what shipped just before) and direct successors (what's
planned next), one edge away — when that shapes how it delivers; knowing what came
before or comes next can genuinely change the right implementation. A coordinator
handed a ticket whose blockers are unmet should not have been dispatched; deciding
*that* is the orchestrator's job.

## The human-handoff path

Some tickets cannot be finished by an agent. Sometimes that is known up front
(the orchestrator detects an explicit tracker signal — see §2.6); sometimes the
coordinator discovers it mid-flight: a decision it cannot make, a credential only
a human holds, a manual step in an external system. This is the
**worker-discovered** handoff.

When a coordinator hits such a wall, it does not block a session waiting for a
human (§2.3 forbids that once assigned). It posts a human-tagged alert through
the §2.3 routing rule, parks the ticket in `awaiting-external`, logs a `WAIT`,
and steps away — releasing its claim so the orchestrator can keep other work
moving. When the human resolves it, the ticket leaves `awaiting-external` and is
re-dispatched fresh. Both handoff paths — orchestrator-detected and
worker-discovered — converge on the same resting state: `awaiting-external`
with exactly one outstanding alert.

## Standalone or dispatched

A coordinator runs in two contexts with one set of rules:

- **Standalone** — a human invokes it directly on one ticket
  (`/work-ticket DEV-123`). There is no orchestrator; the coordinator claims the
  ticket, works it to a terminal role, and reports to the session.
- **Dispatched** — the orchestrator (§2.6) hands it a work item and expects it to
  report terminal outcome through the dispatch artifacts §2.6 defines (an outcome
  artifact, a heartbeated lock). The coordination rules are identical; only the
  reporting surface differs.
