# §2.6.2 — Orchestration Protocol: Normative

## Applicability

This protocol applies to driving one or more **projects** to completion under
CLI-issued work orders. All selected projects MUST live on the same tracker
(§2.3: a ticket on one tracker MUST NOT depend on a ticket on another).

The deterministic half — the graph, scheduling, claims, slots, and emission —
is the channel server's (§3.1). This section specifies what it MUST derive and
emit, and what the orchestrate session and the worker agents MUST do with it.

## The derived read-model

The CLI MUST derive, from the stored graph alone:

- **Classification** per work item, highest precedence first: `verified`,
  `canceled`, `in-flight` (a started status, or a live claim), `dormant`
  (backlog), `blocked`, `human-blocked`, `available`.
- **Effective blocking**: a ticket is blocked by an unresolved ancestor over
  blocking edges — a `verified`/`canceled` ticket does not block, and
  cancellation releases downstream work; a placeholder blocks until written.
  A `ticket → milestone` edge is membership, a `milestone → milestone` edge is
  sequencing, and a member of a milestone is **gated** while any
  sequencing-ancestor milestone is not open.
- **Milestone state**: ready-for-review when it has members, all resolved,
  none dep-blocked; **open** once a recorded review also covers exactly the
  current member set with no member moved after it. A follow-up ticket filed
  into the milestone MUST re-close the gate by invalidating that snapshot.
- **The dispatch queue**: available work ranked injected-first, then priority,
  then descendant fan-out, then id — plus re-admission passes for invested
  work: `resume` (started, no live claim, no outcome), `verify` (delivered
  ticket), `finalize` (decomposed parent whose subtasks resolved), `retry`
  (retryable failure). Nothing human-owned, parked, resolved, or held by a
  live claim is ever queued.
- **Counts and a terminal verdict** per project. A project with an owed
  milestone review is not terminal.
- **Anomalies**: dangling placeholder endpoints, mutually blocking projects,
  cycles (a safety net; writes reject them).

`dispatch status` and `dispatch queue` expose the read-model; agents and
operators MUST read it rather than re-derive any of it.

## The tick

The server MUST run the scheduler on a timer tick and after every tool call.
Each tick, in order:

1. Heartbeat its session row; a server whose row is gone MUST stop scheduling
   and exit rather than re-register. Sweep sessions whose heartbeat is stale —
   their claims and slots cascade away, which is how a crashed session's work
   returns to the queue (as `resume`).
2. Reconcile ingest (§3.1.2): deliver owed fetch instructions and completions.
3. Only once its probe is acknowledged (§3.1.2): **fill** — for each queue
   entry up to free compute capacity, claim the node for this session under an
   immediate transaction, then emit one work order. A node already claimed by
   any live session MUST be skipped, so two servers on one database cannot
   double-dispatch.
4. Emit `perform_milestone_review` for each milestone ready-for-review with no
   valid review and no live claim, claiming the milestone first.
5. Emit the condition orders once per episode, tracked durably:
   `park_human_blocked` for a human-blocked ticket not yet parked,
   `alert_failure` for a non-retryable failure, `project_complete` when a
   project's counts go terminal. A lapsed condition MUST clear its marker so a
   new episode fires again.

Admission is capped by free ledger capacity (`max-parallel` minus held slots)
per tick; the binding compute bound remains the atomic slot acquire below.

## Work orders and the session

The orchestrate session MUST execute orders and derive nothing:

| Order                      | The session MUST                                                    |
| -------------------------- | ------------------------------------------------------------------- |
| `dispatch_ticket`          | launch a background ticket-worker agent with the order's meta       |
| `dispatch_pr`              | launch a background prompt-worker agent with the order's meta       |
| `perform_milestone_review` | launch a background milestone-reviewer agent with the order's meta  |
| `park_human_blocked`       | park the ticket via the adapter and post the human handoff          |
| `alert_failure`            | alert the operator on the ticket via the adapter                    |
| `project_complete`         | announce it; stop once every selected project is complete           |

The session passes a worker only what the order carries plus credential
context — never ticket content. It MUST NOT block on session input for human
questions; those route through the tracker (§2.3). Where no channel is
acknowledged, the session MUST poll the same read-model (`dispatch queue`,
`dispatch status`, `dispatch refresh status`) and handle each entry
identically.

## Workers

Every dispatched worker MUST:

- work only the unit its order names, and never select further work;
- acquire a compute slot before any stage that writes code, installs, builds,
  or tests, and release it for any wait and on exit (`dispatch slot
  acquire`/`release`); at capacity it waits and retries, never proceeds;
- record its final report as its last act: `dispatch outcome set` with
  `verified`, `delivered`, `decomposed`, `canceled`, `human-blocked`, or
  `failed` (`--retryable` only when a fresh run could succeed). Recording
  releases the claim and the actor's slot atomically.

A ticket-worker owns its ticket's §2.3 transitions, decomposition (subtasks
written through the flat commands, then `decomposed`), PR delivery via the
`land` skill, and verification per its pass. A milestone-reviewer either
records the review (`dispatch review record`, snapshotting members and
opening the gate) or files follow-ups and releases the claim
(`dispatch review release`) with the gate closed; it MUST NOT record a review
to clear the order while gaps remain.

## Slot accounting

A **slot** is local compute capacity. The ledger lives in the shared database,
bounded by `max-parallel`; every slot row names the session it rides and an
actor. A slot is released by its holder, by its outcome report, or by the
stale-session sweep — a dead server cannot leak capacity. A unit merely
awaiting CI, review, or a human holds no slot.

## State and recovery

All orchestration state MUST live in the shared database or the
tracker/forge, never only in an agent's memory:

| State                   | Location                                        |
| ----------------------- | ----------------------------------------------- |
| Graph, cursor, refresh  | the dispatch database (a rebuildable cache)     |
| Claims, slots, outcomes | the dispatch database, cascading off sessions   |
| Reviews and snapshots   | the dispatch database                           |
| Condition markers       | the dispatch database                           |
| Ticket status & history | the tracker (authoritative)                     |
| PR terminal state       | the forge (authoritative)                       |

Recovery is re-derivation: a fresh server rebuilds everything from the
database, stale claims return their work as `resume`, and a lost database is
rebuilt by a full re-scan (`dispatch refresh --rebuild`).

## Termination

Orchestration stops when every selected project's read-model is terminal —
announced by `project_complete` per project — or when the operator says stop.
An empty frontier with work in flight, a held ledger, or an outstanding human
handoff is not termination.
