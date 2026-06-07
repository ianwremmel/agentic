# §2.6.2 — Orchestration Protocol: Normative

## Applicability

This protocol applies to an agent driving one or more **projects** to completion
by dispatching ticket coordinators (§2.5) and, for ad-hoc PRs, delivery workers
(§2.4). The agent is the **orchestrator**.

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

| Actor              | Owns                                                                                 | Defined in |
| ------------------ | ------------------------------------------------------------------------------------ | ---------- |
| orchestrator       | merged graph, slot accounting, dispatch/re-dispatch, lock reconciliation, completion | §2.6       |
| ticket coordinator | one ticket end-to-end, ticket↔PR mapping, role transitions, decomposition            | §2.5       |
| delivery worker    | one PR from first commit to merge                                                    | §2.4       |
| review agent       | one milestone's review when it is ready-for-review                                   | §2.3       |
| verification agent | one verification-only (no-PR) ticket                                                 | §2.6       |

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

```
1. Refresh graph:
     delta = producer.delta(cursor, exclude=in_flight ∪ done ∪ failed)
       (or producer.sync(...) on first run / recovery / cursor gap / no delta support)
     merge delta into durable graph cache; persist (graph, cursor)

2. Drain injection inbox (see §Runtime injection): inject tickets as graph nodes
   and bare PRs as top-priority active-set entries

3. Reconcile orphaned locks:
     for each lock (PR / coordinator / verification / review) older than the
        staleness threshold: clear it (and any mirrored "working" label); the
        unit is presumed dead and becomes eligible for re-dispatch

4. For each active unit (from on-disk active set / sentinels), by kind:
     coordinator | bare worker:
        closure = coarse closure check — the PR merged/closed (bare worker), or
                  the ticket reached a terminal §2.3 role (coordinator) — or the
                  unit's outcome artifact; NOT a §2.2 gate evaluation
        if closed/terminal: run the residual §2.3 transition + cleanup; drop it
        elif no live owner (no / stale lock): re-dispatch the same unit
        else: live owner — nothing this tick
     review agent | verification agent (sentinel-tracked):
        if outcome artifact present:
           review                       -> record the review (§2.3); clean sentinel
           verification = verified       -> move the ticket (§2.3); clean sentinel —
                                            the gate opens, dependents unblock next fetch
           verification = retryable-failure -> consume the artifact; re-dispatch
           verification = blocked-failure   -> park the gate; surface to operator;
                                            no re-dispatch (dependents stay blocked)
        elif no live owner (no / stale lock): re-dispatch
        else: live owner — nothing this tick

5. Honor human-blocked nodes (graph `human-blocked`, which already includes both
   the explicit-signal and worker-discovered parkings):
     ensure the ticket is parked in `awaiting-external` (or `paused` if the
        tracker lacks it), transitioning it there if the explicit signal left it
        elsewhere; ensure exactly one outstanding human alert; never dispatch a
        worker or coordinator (§Human-interactive tickets); slot-exempt

6. Milestone-review gate:
     for each milestone ready-for-review AND NOT review-recorded with no live
        review agent: dispatch a review agent (milestone-keyed sentinel; slot-exempt)

7. Fill slots:
     used = non-stale coordinator locks + non-stale bare-worker locks (§Slot accounting)
     dispatch injected bare PRs first (top priority), each consuming one slot,
        while used < MAX_PARALLEL (used += 1 each)
     then for each ticket in `available` (ranked), highest first:
        if target-kind == verification: dispatch verification agent (slot-exempt)
        elif target-kind == human-only: handle per step 5 (never dispatch worker)
        elif used < MAX_PARALLEL: dispatch a ticket coordinator (§2.5); used += 1

8. Persist active set atomically (write-temp-then-rename); the cursor was already
   persisted with the graph cache in step 1 — it has a single source of truth

9. Completion check:
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
- State persistence (step 8) MUST complete before the completion/termination
  check, so the final tick's cleanup and terminal transitions are never lost to an
  early stop.
- Per-unit failures (a producer error for one project, a closure-check failure for
  one PR) MUST be isolated: the orchestrator logs and continues; one unit's
  failure MUST NOT starve the rest.

## Slot accounting

Concurrency is bounded by `MAX_PARALLEL`, an implementation-defined configuration
value, counted over in-flight **PR-bound units**.

- The **used** count is the number of non-stale **locks** held by PR-bound units:
  one per active ticket coordinator plus one per active bare worker. Locks are the
  single source of truth, so the tick's slot math and this count never diverge.
- A ticket coordinator reserves its slot the moment it is dispatched (it holds a
  coordinator lock) and SHOULD run its PRs **sequentially** — one active delivery
  worker — so one coordinator = one slot = one in-flight PR. Reserving at dispatch
  prevents a just-dispatched coordinator, before it has spawned its worker, from
  being double-counted into an over-dispatch.
- A coordinator MAY run PRs concurrently only when the orchestrator has free slots
  to grant; each additional concurrent worker then consumes an additional slot. By
  default a coordinator runs exactly one worker.
- A bare injected PR (no coordinator) holds a worker lock and counts as one slot.
- Verification agents, review agents, and human-blocked tickets are
  **slot-exempt** — tracked by sentinels, not slots — so a gate, check, or pending
  human is never starved by a full slot budget.

## Dispatch contract

When dispatching, the orchestrator passes only the data the unit needs to act; it
never passes ticket *content*. Inputs differ by unit kind:

- **Ticket coordinator** (§2.5): `ticket_id`, `ticket_url`, `target-kind`, any
  branch-name hint, the identity/mode context (§Credential modes), and the §2.3
  hook responsibilities the coordinator owns.
- **Bare worker** (§2.4): the PR's forge identity — `repo`, `pr_number`,
  `pr_url`, and `branch` — plus identity/mode context. A bare PR has no
  coordinator, so the orchestrator (not a coordinator) applies any residual §2.3
  ticket transition on closure when the PR is linked to a ticket.
- **Review agent** (§2.3): the milestone identifier and its project; it records
  the review outcome on the §2.3 review artifact.
- **Verification agent**: the `ticket_id`/`ticket_url` of the verification-only
  ticket; it validates the deployed result and writes an outcome artifact.

The orchestrator MUST require each dispatched unit to maintain liveness and
reporting artifacts:

- A **lock** — PR-keyed (worker), ticket-keyed (coordinator / verification), or
  milestone-keyed (review) — heartbeated on a fixed interval; staleness is judged
  by lock age.
- An **outcome artifact** the unit writes as its final action, which the
  orchestrator reads to reconcile: coordinator outcomes per §2.5 §Reporting;
  verification outcomes are `verified` / `retryable-failure` / `blocked-failure`;
  a review outcome is the recorded-review signal.
- A mirrored "working" signal on the forge/tracker where one is available, kept
  in sync with the lock.

On a unit's outcome the orchestrator MUST run the residual §2.3 work the unit
could not (e.g. advancing a linked ticket's role on PR merge when a bare worker
had no coordinator; recording a milestone review; opening a verification gate) and
MUST clean up the lock, label, worktree (if any), and artifact. A
`retryable-failure` verification re-dispatches on a later tick; a `blocked-failure`
parks the gate and is surfaced to the operator.

A `decomposed` coordinator outcome leaves the parent `in-progress` and effectively
blocked by its new subtasks (§2.5 §Decomposition). The orchestrator MUST track the
parent as a **slot-exempt deferred-finalization** entry — it is neither `available`
nor owned by a live unit — and MUST re-dispatch a coordinator to finalize the
parent once the graph reports every subtask `verified`/`canceled`. This is what
keeps an in-progress parent from being either lost or re-dispatched in a loop while
its subtasks are still running.

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
2. Never dispatch a code worker or coordinator that would attempt the work.
3. Ensure exactly one outstanding human alert exists. The alert is a §2.1
   comment: its first line is the required `<!-- agent-reply:<orchestrator-id> -->`
   machine marker, and a durable human-alert sentinel sits **inside** the body
   (after that marker in Mode A, after the opening sparkle in Mode B — never
   displacing the leading marker), mirroring how §2.4 places its plan and
   engagement sentinels:

   ```
   <!-- agent-human-alert:<orchestrator-id> -->
   ```

   Before posting, the orchestrator MUST scan the routing venue (§2.3) for an
   unresolved alert bearing this sentinel and post only if none exists; this is
   what makes "exactly one" enforceable across stateless ticks. An alert is
   resolved per §2.3 (a human responds with addressable content).
4. Keep the node slot-exempt and re-check it each tick; treat its dependents as
   `blocked` until its role leaves the parked group.

When the human resolves it (a role change visible on the next fetch), the
orchestrator emits `RESUME`; the ticket returns to `available` per §2.3's
park-resume rule and re-enters the frontier.

"Needs a human" MUST NOT be modeled as a new §2.3 role; it is the existing
`awaiting-external` (or `paused`) role plus the graph's `human-interactive` flag.

## Milestone-review gate

When a milestone is `ready-for-review` and not `review-recorded`, the
orchestrator MUST dispatch a **review agent** to run the §2.3 milestone review,
tracked by a milestone-keyed sentinel lock and slot-exempt. The orchestrator MUST
NOT perform the review itself and MUST NOT advance any ticket gated on the
milestone until the graph reports `review-recorded`. The review agent files any
follow-up tickets in the current milestone per §2.3; those re-block advancement
and reach the orchestrator only as a changed frontier.

## Runtime injection

The orchestrator MUST drain an on-disk **injection inbox** each tick:

- An injected **ticket** is added to the graph as an ordinary node. The producer
  MUST pull in its transitive dependency ancestors on the next fetch. The injected
  ticket (and any newly-pulled ancestor that is unblocked) is ranked to the **top
  of the available frontier** but MUST NOT preempt work already in flight — it
  takes the next freed slot.
- An injected **PR** is recorded with its forge identity (`repo`, `pr_number`,
  `pr_url`, `branch`) and added to the active set as a bare delivery worker (no
  coordinator) at top priority (§Dispatch contract). It consumes a worker slot
  that would otherwise go to a ticket and MUST NOT preempt work already in flight.

Injection MUST NOT reclaim a slot from an in-flight unit.

## Credential modes

The orchestrator and the units it dispatches operate under §2.1 Mode A or Mode B,
which governs identity attribution and how human input is routed — **not** how the
tracker is accessed. Mode selection follows §2.1. The producer adapter and the
access mechanism (API/CLI/MCP) are chosen independently by configuration; a given
mode places no constraint on the access style.

## State and recovery

All orchestrator state MUST live on disk or in the tracker/forge, never only in
memory:

| State                  | Location                                               |
| ---------------------- | ------------------------------------------------------ |
| Durable graph + cursor | on-disk normalized cache                               |
| Active work set        | on-disk file (PR-bound + verification + human-blocked) |
| Liveness locks         | on-disk, PR-keyed / ticket-keyed / milestone-keyed     |
| Unit status artifacts  | on-disk, written by each dispatched unit               |
| Milestone summaries    | on-disk, written at milestone boundaries               |
| Ticket roles & history | the tracker (authoritative)                            |
| PR terminal state      | the forge (authoritative)                              |

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

The orchestrator MUST NOT terminate merely because the slot budget is empty, the
available frontier is momentarily empty while work is in flight, a milestone
completed, or a human handoff is outstanding. Resuming is by re-invocation; the
new run reads state from disk and the tracker and continues.
