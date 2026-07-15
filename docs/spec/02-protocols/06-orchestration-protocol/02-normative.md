# §2.6.2 — Orchestration Protocol: Normative

## Applicability

This protocol applies to an agent driving one or more **projects** to completion
by dispatching ticket coordinators (§2.5) — which internally drive §2.4 delivery
workers — and milestone review agents. The agent is the **orchestrator**.

All selected projects MUST live on the same tracker. Cross-tracker orchestration
is out of scope (§2.3: a ticket on one tracker MUST NOT depend on a ticket on
another).

The orchestrator is explicitly assigned (the project lead/owner is its identity,
or a skill invocation names the projects) and is therefore subject to the §2.3
communication restriction.

### Plan-mode guard

The orchestrator dispatches subagents and drives a long-running loop; it MUST NOT
operate in a read-only planning mode. If invoked in such a mode it MUST decline
and instruct the operator to re-invoke outside it.

## Actor model

The orchestrator MUST respect these responsibility boundaries:

| Actor                  | Owns                                                                                                                                    | Defined in |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| orchestrator           | merged graph, slot ledger, coordinator dispatch/re-dispatch, lock reconciliation, completion                                            | §2.6       |
| ticket coordinator     | one work item end-to-end — its PR(s), a no-PR verification, or a single injected PR; ticket↔PR mapping; role transitions; decomposition | §2.5       |
| milestone review agent | one milestone's review when it is ready-for-review                                                                                      | §2.3, §2.6 |

The orchestrator dispatches **only** coordinators and milestone-review agents.
There is no separate verification agent or orchestrator-dispatched bare worker:
verification-only tickets and injected bare PRs are both worked by a coordinator,
which keeps the orchestrator a clean graph→coordinator dispatcher with no per-kind
special cases. A coordinator internally drives §2.4 **delivery workers** (one per
PR); those workers are not dispatched by the orchestrator but draw compute slots
from the same ledger (§Slot accounting).

The orchestrator MUST NOT read raw ticket bodies, evaluate CI/review/Copilot
state, or perform a milestone review itself. It acts only on the derived sections
of the project-graph document (§The project-graph document) and the on-disk
dispatch bookkeeping.

## The project-graph document

The orchestrator reads project state exclusively from a **tracker-neutral
project-graph document** produced per §Producer contract. This protocol defines
the document's required *logical contents* below; the concrete serialization
(XML, JSON, …) and field encodings are implementation-defined, provided the
producer and orchestrator agree on one. The document MUST contain:

- A root spanning one or more projects (the multi-project merge).
- For each ticket, a node carrying at minimum: `id`, `url`, §2.3 `role` and
  `group`, milestone membership, effective-blocked status (§2.3), a
  `human-interactive` flag, and a `target-kind` of `pr`, `verification`, or
  `human-only`. A node MAY carry `labels` and non-authoritative dispatch hints (a
  branch-name seed); the orchestrator consumes `labels` only as the source of the
  configured `human-interactive` signal, never to reason over ticket content.
- Derived sections, computed by the producer across **all** projects:

| Section               | Contents                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `available`           | Ranked frontier of unblocked tickets eligible to be picked up.                                                                                                                                           |
| `blocked`             | Tickets effectively-blocked (§2.3) by an ancestor not yet `verified`/`canceled`, or by an unreviewed milestone gate; expected to unblock as ancestors resolve.                                           |
| `human-blocked`       | Tickets parked pending a human (explicit signal or worker-discovered).                                                                                                                                   |
| `permanently-blocked` | Tickets that can never become `available`: a blocking ancestor terminated without `verified` and will not progress (e.g. a failed/abandoned ticket left parked). Producer-classified; tracker-dependent. |
| `milestones`          | One entry per milestone with `ready-for-review` and `review-recorded` flags.                                                                                                                             |
| `counts`              | Per-project and per-milestone tallies sufficient for completion detection.                                                                                                                               |
| `anomalies`           | Cycles and cross-project reverse-dependency edges (§2.3).                                                                                                                                                |

The orchestrator MUST treat the derived sections as authoritative and MUST NOT
re-derive blocking, ranking, or cycle detection itself. On an `anomalies` entry
the orchestrator MUST surface it and MUST NOT silently work around it (a cycle is
illegal per §2.3).

Per §2.3's effective-blocking rule, a `canceled` ancestor does **not** block its
dependents — cancellation *unblocks* downstream work rather than permanently
blocking it. A producer MUST therefore NOT place a ticket in `permanently-blocked`
solely because an ancestor was canceled; such a dependent moves to `available`.

**Milestone-review gating is expressed as effective-blocking.** §2.3 requires a
milestone review before the *next* milestone is started. The orchestrator
satisfies this without a milestone state machine: the producer reports a ticket
whose start depends on a prior milestone as `blocked` until that milestone is both
`ready-for-review` and `review-recorded`. Graph-frontier execution does not
violate §2.3's sequencing — the unblocked frontier only ever spans milestones
whose predecessors are already review-recorded; tickets gated behind an unreviewed
milestone never appear in `available`.

`review-recorded` is scoped to the milestone's **current** ready-for-review
episode, not a permanent flag. If a review files follow-up tickets into the
milestone (§2.3), the milestone regains incomplete work and is no longer
`ready-for-review`; when it re-completes, `review-recorded` MUST again be false
until a fresh review runs. A producer MUST NOT let a stale review record suppress
the re-review §2.3 mandates.

## Producer contract

A **producer** emits the project-graph document. The orchestrator invokes it
identically regardless of tracker or access mechanism.

- A producer MUST support a **full sync** that emits the complete document for the
  selected projects.
- A producer SHOULD support an **incremental delta** keyed by an opaque
  `cursor`, emitting only nodes/edges changed since that cursor plus refreshed
  derived sections. Incremental fetch is the steady state: the orchestrator MUST
  use the delta path on every tick where the producer supports it, falling back
  to a full sync only on first run, after recovery, on a cursor gap, or when the
  producer does not support delta.
- The `cursor` is tracker-defined and opaque to the orchestrator (e.g. Linear
  `updatedAt`, Jira `updated`, GitHub `since`). The orchestrator MUST persist the
  latest cursor and pass it back on the next delta call.
- The producer MUST perform all graph reasoning — effective-blocking (§2.3),
  ranking, cycle detection — so the document the orchestrator reads is already
  derived.
- The producer MUST accept the orchestrator's exclusion inputs (the identifiers
  of tickets already in flight, done, or failed). Exclusions affect only the
  derived scheduling sections — an excluded ticket MUST NOT appear in `available`
  — and MUST NOT suppress node/edge updates: a sync or delta MUST still emit the
  current state of an excluded ticket, so the durable cache never goes stale for
  in-flight or terminal work.

**Access style is orthogonal to credential mode.** Whether a producer reaches the
tracker via API, CLI, or MCP is an adapter detail selected by configuration. It
MUST NOT be conflated with the §2.1 mode. The §2.1 mode governs only identity
attribution and human-input routing (§Credential modes).

Adapters for specific trackers are implementation-defined and added incrementally;
this protocol defines only the document and the producer contract they satisfy.

## Durable graph cache

The orchestrator MUST maintain a **durable normalized graph** on disk plus the
latest sync `cursor`. Each tick:

1. Request a delta from the producer using the persisted cursor (or a full sync
   on first run, after recovery, or when the producer reports a cursor gap).
2. Apply the delta to the cached graph by a deterministic mechanical merge (add/
   update/remove nodes and edges; replace derived sections). This merge MUST NOT
   involve graph reasoning — that is the producer's output.
3. Persist the updated graph and cursor atomically (write-temp-then-rename).

The cache MUST be reconstructible by a full sync; no orchestrator state may exist
only in memory across ticks.

## The tick

The orchestrator runs as a series of **stateless ticks**. Each tick is a fresh
context that reads all state from disk and the tracker, acts, and exits. The
following MUST occur each tick, in order:

```text
1. Refresh graph:
     delta = producer.delta(cursor, exclude=in_flight ∪ done ∪ failed)
       (or producer.sync(...) on first run / recovery / cursor gap / no delta support)
     merge delta into durable graph cache; persist (graph, cursor)

2. Drain injection inbox (§Runtime injection): inject tickets as graph nodes;
   record injected bare PRs as top-priority active-set entries (each driven by a
   coordinator)

3. Reconcile orphaned locks and stale slots:
     for each coordinator lock (ticket-keyed or PR-keyed) or milestone-review lock
        older than the staleness threshold: clear it (and any mirrored "working"
        label); the unit is presumed dead and eligible for re-dispatch
     for each ledger entry whose owner's heartbeat is stale: reclaim it, so a
        crashed agent cannot leak capacity (§Slot accounting)

4. Reconcile each active coordinator (from the active set), by its outcome artifact
   if one was written, else by liveness. The §2.5 outcomes are handled exhaustively:
     outcome present:
        verified | canceled                  -> cleanup + drop (terminal; coordinator owns the §2.3 transitions)
        delivered                            -> cleanup + drop; a separate verification work item takes the ticket to `verified`
        human-blocked                        -> cleanup + drop; the parked ticket is handled at step 6
        decomposed                           -> cleanup; record the parent as a deferred-finalization entry (§Dispatch contract)
        failed, verification + retryable     -> re-dispatch
        failed, verification + not retryable -> park (the gate stays blocked); surface to the operator; no re-dispatch
        failed, other                        -> cleanup + drop; surface to the operator; no auto-re-dispatch
     no outcome artifact:
        if the work item is terminal (ticket at a terminal §2.3 role, or a bare PR
           merged/closed): cleanup + drop
        elif no live owner (no / stale lock): re-dispatch the same coordinator
        else: live owner — nothing this tick

5. Reconcile each milestone-review agent (sentinel-tracked):
     if the review outcome is recorded: clean the sentinel — the gate opens and
        gated tickets unblock via the next fetch
     elif no live owner (no / stale lock): re-dispatch
     else: live owner — nothing this tick

6. Honor human-blocked nodes (graph `human-blocked`, which already includes the
   explicit-signal and worker-discovered parkings):
     ensure the ticket is parked in `awaiting-external` (or `paused` if the tracker
        lacks it), transitioning it there if an explicit signal left it elsewhere;
        ensure exactly one outstanding human alert; never dispatch a coordinator
        for it (§Human-interactive tickets)

7. Milestone-review gate:
     for each milestone ready-for-review AND NOT review-recorded with no live
        milestone-review agent: dispatch one (milestone-keyed sentinel)

8. Fill work (gated on local-compute capacity, §Slot accounting):
     budget = number of free ledger entries at the START of this step
     while budget > 0 AND startable work remains:
        next = first available, in priority order:
                 (a) an injected bare PR,
                 (b) a deferred-finalization parent whose subtasks are all
                     `verified`/`canceled` (per the graph),
                 (c) the highest-ranked `available` ticket with target-kind `pr`
                     or `verification`
               (`human-only` tickets are handled at step 6, never dispatched)
        if no `next`: break
        dispatch a coordinator (§2.5) for `next`; budget -= 1
     Dispatch reserves no ledger entry — the coordinator and its delivery workers
     acquire their own as they reach compute stages (§Slot accounting). Capping this
     tick's dispatches at the start-of-step free count keeps one tick from admitting
     more agents than the host can currently compute; the atomic acquire stays the
     hard bound.

9. Persist active set atomically (the cursor was already persisted in step 1 — it
   has a single source of truth)

10. Completion check:
     if every selected project's counts are terminal: stop (see §Termination)
     else exit tick (context released)
```

Conformance requirements on the tick:

- The orchestrator MUST be **stateless across ticks**: every decision derives from
  the on-disk graph cache, active set, locks, and the current producer output.
- A tick MAY load the graph and active set into memory to do its work, but MUST
  NOT treat in-memory state as authoritative across tick boundaries — the next
  tick re-reads them from disk rather than carrying them over.
- The orchestrator MUST NOT use a detached background poll loop, and MUST NOT
  re-dispatch a unit that already has a live (non-stale) lock — a second dispatch
  races the first on the same ticket/PR.
- State persistence (step 9) MUST complete before the completion/termination
  check, so the final tick's cleanup and terminal transitions are never lost to an
  early stop.
- Per-unit failures (a producer error for one project, a closure-check failure for
  one PR) MUST be isolated: the orchestrator logs and continues; one unit's
  failure MUST NOT starve the rest.

## Slot accounting

A **slot** represents local-system **compute capacity** — the right to write
code, install dependencies, build, or run tests on the host the agents share.
`MAX_PARALLEL` (implementation-defined) bounds how many agents may be in such a
stage at once, so concurrent local work never exhausts the machine. Slots are
about **local compute, not work-in-flight**: a PR that is merely open and awaiting
CI, review, or merge holds **no** slot.

- Slots live in a single shared on-disk **ledger** of `MAX_PARALLEL` entries. Every
  agent that may compute — coordinators and the §2.4 delivery workers they spawn —
  draws from this one ledger. It is the single source of truth for the bound. Each
  entry records its **owner** and a heartbeat.
- An agent MUST atomically **acquire** a ledger entry before entering any stage
  that may write code, install, build, or run tests, and MUST **release** it on
  leaving that stage for any wait (CI, review, merge, a human handoff, idle
  polling) or on exit. If no entry is free when an agent reaches a compute stage,
  it waits and retries — it never exceeds the bound.
- The orchestrator does **not** pre-reserve entries at dispatch. It gates *new
  coordinator dispatch* on the ledger having free capacity — a soft admission check
  that avoids spawning far more agents than can compute — but the binding bound is
  the atomic acquire above: two coordinators admitted in the same tick still
  serialize at the ledger when they reach their compute stages.
- A delivery worker is not an orchestrator-dispatched actor and holds no
  orchestrator lock, but it draws its compute entry from this same global ledger.
  That is how a worker's reservation bubbles up: every concurrent build — whichever
  coordinator spawned it — counts against the one `MAX_PARALLEL` bound. A
  coordinator running several independent PRs holds one entry per
  concurrently-building worker.
- The orchestrator's tick (step 3) reclaims any entry whose owner's heartbeat is
  stale, so a crashed coordinator or worker cannot leak capacity. Terminal cleanup
  never force-releases a *live* worker's entry — entries are released only by their
  owner or by stale reclamation.
- Because every wait releases the entry, nothing is permanently reserved and
  nothing is starved: an agent parked on CI, a reviewer, or a human holds no entry,
  so a milestone-review agent or a freshly-unblocked ticket always finds capacity
  as in-flight work idles.

## Dispatch contract

When dispatching, the orchestrator passes only the data the unit needs to act; it
never passes ticket *content*. It dispatches two kinds of unit:

- **Ticket coordinator** (§2.5) — for every `pr` and `verification` ticket, and
  for each injected bare PR. Inputs: `ticket_id` and `ticket_url` (for a bare PR
  with no ticket, the PR's forge identity instead — `repo`, `pr_number`,
  `pr_url`, `branch`), `target-kind`, any branch-name hint, the identity/mode
  context (§Credential modes), and the §2.3 hook responsibilities the coordinator
  owns. The coordinator branches on `target-kind`: drive PR(s) via §2.4, or run a
  no-PR verification.
- **Milestone review agent** (§2.3, §2.6) — for a milestone that is
  ready-for-review and not yet review-recorded. Inputs: the milestone identifier
  and its project. It records the review outcome on the §2.3 review artifact and
  routes any human-input request through that artifact's comments (§2.3).

The orchestrator MUST require each dispatched unit to maintain liveness and
reporting artifacts:

- A **lock** — ticket-keyed (a coordinator with a ticket), PR-keyed (a bare-PR
  coordinator with no ticket), or milestone-keyed (milestone review agent) — heartbeated on a
  fixed interval; staleness is judged by lock age. A coordinator's §2.4 delivery
  workers hold their own compute-slot entries (§Slot accounting), not separate
  orchestrator locks.
- An **outcome artifact** the unit writes as its final action, which the
  orchestrator reads to reconcile. Coordinator outcomes are per §2.5 §Reporting; a
  verification coordinator's `failed` outcome additionally carries a `retryable`
  boolean — when `retryable` it re-dispatches on a later tick, otherwise the
  verification gate is parked and surfaced to the operator (tick step 4). A review
  agent's outcome is the recorded-review signal.
- A mirrored "working" signal on the forge/tracker where one is available, kept
  in sync with the lock.

Because every work item now runs through a coordinator, the coordinator owns all
of its ticket's §2.3 transitions and verification/DoD artifacts. On a coordinator's
terminal outcome the orchestrator therefore performs **cleanup only** — lock,
"working" label, worktree (if any), and the artifact. Compute-slot entries are not
force-released here: a terminal coordinator's workers have already released theirs,
and any straggler is reclaimed by the stale-heartbeat sweep (§Slot accounting). For
a milestone-review agent, the orchestrator confirms the review outcome was
recorded, then cleans the sentinel.

A `decomposed` coordinator outcome leaves the parent `in-progress` and effectively
blocked by its new subtasks (§2.5 §Decomposition). The orchestrator MUST track the
parent as a **deferred-finalization** entry — neither `available` nor owned by a
live unit, holding no slot — and MUST dispatch a coordinator to finalize the parent
once the graph reports every subtask `verified`/`canceled`. This keeps an
in-progress parent from being lost or re-dispatched in a loop while its subtasks
run.

## Human-interactive tickets

A node is human-interactive when **either**:

- the graph marks it `human-interactive` (an explicit tracker signal — a label or
  field — mapped in configuration, consistent with §2.3's metadata-driven
  overrides), **or**
- a coordinator parked it in `awaiting-external` via the §2.5 worker-discovered
  handoff.

For any human-interactive node the orchestrator MUST:

1. Ensure the ticket is parked in `awaiting-external` (or `paused` if the tracker
   lacks `awaiting-external`). The worker-discovered path already parked it; for
   the explicit-signal path the orchestrator transitions it there per §2.3 if it
   is not already parked. Both paths thus converge on the same parked role.
2. Never dispatch a coordinator that would attempt the work.
3. Ensure exactly one outstanding human alert exists. The alert is a §2.1
   comment: its first line is the required `<!-- agent-reply:<orchestrator-id> -->`
   machine marker, and a durable human-alert sentinel sits **inside** the body
   (after that marker in Mode A, after the opening sparkle in Mode B — never
   displacing the leading marker), mirroring how §2.4 places its plan and
   engagement sentinels:

   ```text
   <!-- agent-human-alert:<orchestrator-id> -->
   ```

   Before posting, the orchestrator MUST scan the routing venue (§2.3) for an
   unresolved alert bearing this sentinel and post only if none exists; this is
   what makes "exactly one" enforceable across stateless ticks. An alert is
   resolved per §2.3 (a human responds with addressable content).
4. Re-check it each tick; treat its dependents as `blocked` until its role leaves
   the parked group. A parked ticket holds no slot — it is not computing.

When the human resolves it (a role change visible on the next fetch), the
orchestrator emits `RESUME`; the ticket returns to `available` per §2.3's
park-resume rule and re-enters the frontier.

"Needs a human" MUST NOT be modeled as a new §2.3 role; it is the existing
`awaiting-external` (or `paused`) role plus the graph's `human-interactive` flag.

## Milestone-review gate

When a milestone is `ready-for-review` and not `review-recorded`, the
orchestrator MUST dispatch a **milestone review agent** to run the §2.3 milestone
review, tracked by a milestone-keyed sentinel lock. The orchestrator MUST NOT
perform the review itself and MUST NOT advance any ticket gated on the milestone
until the graph reports `review-recorded`. The review agent files any follow-up
tickets in the current milestone per §2.3; those re-block advancement and reach
the orchestrator only as a changed frontier.

Milestone review frequently needs human judgment. §2.3 already designates the
milestone's **review artifact** (a Linear project update, a GitHub Milestone
closure comment, an Asana milestone-task comment) as where a milestone review's
outcome is recorded. The milestone review agent MUST solicit any human input it
needs as a comment on that same review artifact, tagging a human — never through
the session — and MUST NOT record the review outcome until that input resolves.
This keeps the conversation in the tracker, consistent with the §2.3 communication
restriction. (A team that wants a human to *own* the review outright can model the
milestone-review item as `human-interactive` and let that path handle it; the
default is agent-run with comment-routed human input.)

## Runtime injection

The orchestrator MUST drain an on-disk **injection inbox** each tick:

- An injected **ticket** is added to the graph as an ordinary node. The producer
  MUST pull in its transitive dependency ancestors on the next fetch. The injected
  ticket (and any newly-pulled ancestor that is unblocked) is ranked to the **top
  of the available frontier** but MUST NOT preempt work already in flight — it is
  dispatched ahead of lower-ranked tickets at the next tick that has free ledger
  capacity.
- An injected **PR** is recorded with its forge identity (`repo`, `pr_number`,
  `pr_url`, `branch`) and added to the active set as a top-priority entry driven by
  a **coordinator** scoped to that PR (§Dispatch contract) — not a bare worker. It
  is dispatched ahead of a lower-ranked ticket and MUST NOT preempt work already in
  flight.

Injection MUST NOT interrupt or reclaim resources from a unit already in flight.

## Credential modes

The orchestrator and the units it dispatches operate under §2.1 Mode A or Mode B,
which governs identity attribution and how human input is routed — **not** how the
tracker is accessed. Mode selection follows §2.1. The producer adapter and the
access mechanism (API/CLI/MCP) are chosen independently by configuration; a given
mode places no constraint on the access style.

## State and recovery

All orchestrator state MUST live on disk or in the tracker/forge, never only in
memory:

| State                  | Location                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| Durable graph + cursor | on-disk normalized cache                                                   |
| Active work set        | on-disk file (coordinators + deferred-finalization + human-blocked)        |
| Slot ledger            | on-disk, `MAX_PARALLEL` compute entries (shared by all agents)             |
| Liveness locks         | on-disk, ticket-keyed or PR-keyed (coordinator) / milestone-keyed (review) |
| Outcome artifacts      | on-disk, written by each dispatched unit                                   |
| Milestone summaries    | on-disk, written at milestone boundaries                                   |
| Ticket roles & history | the tracker (authoritative)                                                |
| PR terminal state      | the forge (authoritative)                                                  |

After a loss of on-disk state the orchestrator MUST be able to recover from a full
producer sync plus the forge's open-PR list: missing locks mean no live units;
the next tick re-dispatches as needed. Recovery MUST NOT depend on any in-memory
counter.

## Logging

The orchestrator MUST emit §2.3 operational log entries: `INFO` for dispatch,
slot fill, cleanup, and reassignment; `WAIT`/`RESUME` around human-blocked
tickets it is tracking; `ERROR` for producer and tracker failures. Heartbeat
`INFO` entries SHOULD be emitted while the loop is otherwise idle so observers can
confirm liveness.

## Termination

The orchestrator terminates — stops ticking and exits — when EITHER:

- **Every selected project's graph is terminal** — all tickets are `verified`,
  `canceled`, or permanently-blocked, per the document's `counts`; or
- **The operator explicitly instructs it to stop**, acknowledged per §2.1.

The orchestrator MUST NOT terminate merely because every compute slot is held, the
available frontier is momentarily empty while work is in flight, a milestone
completed, or a human handoff is outstanding. Resuming is by re-invocation; the
new run reads state from disk and the tracker and continues.
