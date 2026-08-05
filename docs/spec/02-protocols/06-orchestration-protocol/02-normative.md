# §2.6.2 — Orchestration Protocol: Normative

## Applicability

This protocol applies to driving one or more **projects** to completion under
CLI-issued work orders. All selected projects MUST live on the same tracker
(§2.3: a ticket on one tracker MUST NOT depend on a ticket on another).

The deterministic half — the graph, scheduling, claims, and emission — is the
channel server's (§3.1). This section specifies what it MUST derive and
emit, and what the orchestrate session and the worker agents MUST do with it.

## The derived read-model

The CLI MUST derive, from the stored graph alone:

- **Classification** per work item, highest precedence first: `verified`,
  `canceled`, `in-flight` (a started status, or a live claim), `dormant`
  (backlog), `blocked`, `human-blocked`, `available`. A PR item whose outcome
  is `human-blocked` classifies `human-blocked` directly — it has no status to
  park. A ticket whose `human-blocked` outcome a later tracker update
  contradicts (updated after the report, now available: the human responded)
  re-enters the queue as a `resume` pass.
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
  work: `resume` (started, no live claim, no outcome — or a `human-blocked`
  ticket back to available via a tracker update that postdates the report),
  `verify` (delivered ticket), `finalize` (decomposed parent whose subtasks
  resolved), `retry` (retryable failure). Nothing human-owned, parked,
  resolved, or held by a live claim is ever queued.
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
   their claims cascade away, which is how a crashed session's work returns
   to the queue (as `resume`).
2. Reconcile ingest (§3.1.2): deliver owed fetch instructions and completions.
3. Only once its probe is acknowledged (§3.1.2): compute the tick's admission
   budget — `max-parallel` minus everything in flight, where a unit in flight
   is a node claimed by a live session. Then **reviews** — emit `perform_milestone_review` for each
   milestone ready-for-review with no valid review and no live claim, claiming
   the milestone first, up to the budget. Reviews spend first: a review
   continues already-landed work and opens a gate other work waits behind.
4. **Fill** — for each queue entry up to the remaining budget, claim the node
   for this session under an immediate transaction, then emit one work order.
   A node already claimed by any live session MUST be skipped, so two servers
   on one database cannot double-dispatch.
5. Emit the condition orders once per episode, tracked durably:
   `park_human_blocked` for a human-blocked ticket not yet parked,
   `alert_failure` for a non-retryable failure or a PR item waiting on an
   operator response (`human-blocked` outcome), `project_complete` when a
   project's counts go terminal. A lapsed condition MUST clear its marker so a
   new episode fires again.

A claim is an obligation to launch an agent and that agent's compute grant in
one, so the budget bounds total obligations outstanding, not admissions per
tick: claims accumulated on earlier ticks consume capacity until they are
released.

For the claim count to bound concurrent compute rather than merely concurrent
obligations, a worker MUST NOT hold its claim across a wait: on reaching a
wait for CI, a review, a merge, or a human, it MUST hand the wait to the
server (§3.1.2) and return, which releases the claim. A worker that instead
polls in the foreground holds capacity it is not using, and enough of them
starve the queue.

Because the budget is computed before any claim is taken, and two servers can
compute it from the same reading, the budget alone does not bound anything
across sessions. The claim write MUST therefore enforce the cap inside its own
transaction and refuse a fresh claim that would exceed it; the budget only
bounds how much one tick attempts.

## Work orders and the session

The orchestrate session MUST execute orders and derive nothing:

| Order                      | The session MUST                                                    |
| -------------------------- | ------------------------------------------------------------------- |
| `dispatch_ticket`          | launch a background ticket-worker agent with the order's meta       |
| `dispatch_pr`              | launch a background pr-worker agent with the order's meta           |
| `perform_milestone_review` | launch a background milestone-reviewer agent with the order's meta  |
| `park_human_blocked`       | park the ticket via the adapter and post the human handoff          |
| `alert_failure`            | alert the operator at the venue the order body names (PR-first)     |
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
- treat its dispatch as its compute grant — there is nothing to acquire, and
  a worker MUST NOT wait for capacity, because it is not launched without it;
- record its final report as its last act: `dispatch outcome set` with
  `verified`, `delivered`, `decomposed`, `canceled`, `human-blocked`, or
  `failed` (`--retryable` only when a fresh run could succeed). Recording
  releases the claim atomically.

A ticket-worker owns its ticket's coordination and never its implementation:
the §2.3 transitions, decomposition into subtasks or PR items (written
through the flat commands with a blocking edge each, then `decomposed`), and
verification per its pass. A pr-worker owns one PR item's implementation —
delivery via the `land` skill — and never a ticket transition. A
milestone-reviewer either
records the review (`dispatch review record`, snapshotting members and
opening the gate) or files follow-ups and releases the claim
(`dispatch review release`) with the gate closed; it MUST NOT record a review
to clear the order while gaps remain.

## Compute accounting

There is one ledger: the claims, bounded by `max-parallel`. A claim is created
by the scheduler when it emits a work order and released by the outcome report
or the stale-session sweep — a dead server cannot leak capacity. A unit merely
awaiting CI, review, or a human holds no claim, because the wait itself is
handed back to the server.

## State and recovery

All orchestration state MUST live in the shared database or the
tracker/forge, never only in an agent's memory:

| State                   | Location                                        |
| ----------------------- | ----------------------------------------------- |
| Graph, cursor, refresh  | the dispatch database (a rebuildable cache)     |
| Claims and outcomes     | the dispatch database, cascading off sessions   |
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
