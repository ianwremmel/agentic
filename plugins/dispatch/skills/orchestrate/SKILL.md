---
name: orchestrate
description: Drive one or more projects to completion by dispatching §2.5 ticket coordinators and milestone-review agents over a merged dependency graph. A thin, stateless-tick graph→coordinator dispatcher — owns the graph, the slot ledger, and the bookkeeping; never reads ticket bodies, evaluates CI/review, or runs a review itself. Use whenever the unit of work is a whole project (or several), standalone (/orchestrate P-1 P-2) or as a long-running loop.
---

# orchestrate

Drive a **dependency graph** of tickets across one or more projects to
completion. The orchestrator owns only the *graph* and the *bookkeeping*: which
tickets are unblocked, which have a live owner, which compute slot is free,
whether a milestone is ready for review. It dispatches **only** §2.5 ticket
coordinators (which internally drive §2.4 delivery workers) and milestone-review
agents, sheds its context every tick, and reads project state **exclusively**
from the project-graph document and the on-disk bookkeeping in
[`reference.md`](./reference.md). It implements the Orchestration Protocol (§2.6).

**Operator** = the human directing this run; the only human with stop authority.
All selected projects MUST live on **one tracker** (§2.3 forbids a cross-tracker
dependency). Wire format, slot ledger, and dispatch artifacts:
[`reference.md`](./reference.md).

**Plan-mode guard.** The orchestrator dispatches subagents and drives a
long-running loop. If invoked in a read-only / planning mode it MUST decline
immediately and instruct the operator to re-invoke outside that mode — never
attempt a partial pass.

## Boundaries

The orchestrator MUST NOT read raw ticket bodies, evaluate CI/review/Copilot
state, perform a milestone review, or re-derive blocking, ranking, or cycle
detection. Those belong to the coordinator, the milestone-review agent, and the
**producer**. It acts only on the derived sections and node tags of the
project-graph document ([`reference.md`](./reference.md#project-graph-document))
and the on-disk dispatch bookkeeping. On any `<anomalies>` entry (a cycle or a
cross-project reverse edge) it MUST **surface** it and MUST NOT silently work
around it — a cycle is illegal (§2.3).

| Actor                  | Owns                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| orchestrator           | merged graph, slot ledger, coordinator dispatch/re-dispatch, lock reconciliation, completion |
| ticket coordinator     | one work item end-to-end (§2.5) — its PR(s), a no-PR verification, or a single injected PR    |
| milestone-review agent | one milestone's review when it is `ready-for-review` (§2.3, §2.6)                             |

There is **no** separate verification agent or bare worker: verification-only
tickets and injected bare PRs are both worked by a **coordinator** that branches
on `target-kind`. A coordinator's §2.4 delivery workers are not dispatched by the
orchestrator but draw compute slots from the same ledger (§Slot ledger).

## The tick

The orchestrator runs as a series of **stateless ticks** — each a fresh context
that reads all state from disk and the tracker, acts, and exits. Every decision
derives from the on-disk graph cache, active set, locks, slot ledger, and the
current producer output; a tick MAY load them into memory but MUST NOT treat
in-memory state as authoritative across tick boundaries. Run these steps **in
order** each tick:

### 1. Refresh graph

Request a **delta** from the producer using the persisted cursor, excluding the
in-flight ∪ done ∪ failed identifiers (the active set):

```
delta = producer.delta(cursor, exclude=<in-flight ∪ done ∪ failed>)
```

Fall back to a **full sync** only on first run, after recovery, on a cursor gap,
or when the producer has no delta support. Delta is the steady state — use it on
every tick the producer supports it. Merge the result into the durable cache by a
deterministic **mechanical** merge (add/update/remove nodes and edges by `id`;
apply `removed="true"` tombstones; **replace all seven derived sections
wholesale** — they are never partial); this merge involves **no** graph
reasoning. Persist the updated graph **and** the new cursor atomically
(write-temp-then-rename). The cursor is opaque — persist it verbatim and pass it
back next tick. The cache MUST be reconstructible by a full sync; no state lives
only in memory across ticks. See [`reference.md`](./reference.md#full-sync-shape-vs-delta-shape).

### 2. Drain injection inbox (§Runtime injection)

For each entry in the on-disk injection inbox:

- **ticket** → add it to the graph as an ordinary node (the producer pulls in its
  transitive ancestors on the next fetch); it ranks to the **top** of `available`
  but is dispatched only at step 8 with free capacity — it MUST NOT preempt work
  in flight.
- **bare PR** → record its forge identity (`repo`, `pr_number`, `pr_url`,
  `branch`) as a **top-priority active-set entry** driven by a coordinator scoped
  to that PR (PR-keyed lock).

Injection MUST NOT interrupt or reclaim resources from a unit already in flight.

### 3. Reconcile orphaned locks and stale slots

- For each coordinator lock (ticket- or PR-keyed) or milestone-review lock older
  than the staleness threshold: **clear it** (and any mirrored "working" label);
  the unit is presumed dead and eligible for re-dispatch.
- For each ledger entry whose owner's heartbeat is stale: **reclaim it** (null the
  entry under `ledger.lock`), so a crashed coordinator or worker cannot leak
  capacity. Never force-release a *live* worker's entry — entries are released
  only by their owner or by this sweep (§Slot ledger).

### 4. Reconcile each active coordinator

For each coordinator in the active set, reconcile by its **outcome artifact** if
one was written, else by **liveness**. The §2.5 outcomes are handled
exhaustively ([`reference.md`](./reference.md#outcome-artifact-vocabulary)):

| Outcome                                    | Action                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `verified`                                 | cleanup + drop (terminal; coordinator owns the §2.3 transition + DoD artifact)            |
| `canceled`                                 | cleanup + drop (terminal; a `canceled` ancestor unblocks dependents on the next fetch)     |
| `delivered`                                | cleanup + drop; a **separate** verification work item later takes the ticket to `verified` |
| `human-blocked`                            | cleanup + drop; the parked ticket is then honored at step 6                                |
| `decomposed`                               | cleanup; record the parent as a **deferred-finalization** entry (§Deferred finalization)   |
| `failed` (verification, `retryable=true`)  | **re-dispatch** on a later tick                                                            |
| `failed` (verification, `retryable=false`) | **park** (the verification gate stays blocked); surface to the operator; **no** re-dispatch |
| `failed` (other)                           | cleanup + drop; surface to the operator; **no** auto-re-dispatch                          |

**No outcome artifact** → reconcile by liveness:

- work item is **terminal** (ticket at a terminal §2.3 role, or a bare PR
  merged/closed) → cleanup + drop;
- **no live owner** (no / stale lock) → **re-dispatch** the same coordinator;
- **live owner** → nothing this tick.

**Cleanup** is cleanup *only* — lock, "working" label, worktree (if any), and the
outcome artifact. The coordinator owns all §2.3 transitions and verification/DoD
artifacts; the orchestrator performs **none** itself. Do **not** force-release
compute entries: a terminal coordinator's workers already released theirs, and
any straggler is reclaimed by step 3.

### 5. Reconcile each milestone-review agent

Sentinel-tracked (milestone-keyed lock `<project>/<milestone-id>`):

- review outcome **recorded** → clean the sentinel; the gate opens and gated
  tickets unblock via the next fetch;
- **no live owner** → re-dispatch;
- **live owner** → nothing this tick.

### 6. Honor human-blocked nodes

For each node in the graph's `<human-blocked>` section (which already merges the
explicit-signal and worker-discovered parkings — never re-derive it):

1. Ensure the ticket is parked in `awaiting-external` (or `paused` if the tracker
   lacks it). The worker-discovered path already parked it; for the
   explicit-signal path transition it there per §2.3 if not already parked.
2. **Never** dispatch a coordinator for it.
3. Ensure **exactly one** outstanding human alert. The alert is a §2.1 comment
   whose first line is the `<!-- agent-reply:<orchestrator-id> -->` marker, with a
   durable `<!-- agent-human-alert:<orchestrator-id> -->` sentinel **inside** the
   body (after the marker in Mode A, after the opening sparkle in Mode B — never
   displacing the leading marker). **Before posting, scan the §2.3 routing venue
   for an unresolved alert bearing this sentinel and post only if none exists** —
   this is what makes "exactly one" enforceable across stateless ticks. Log
   `WAIT`.
4. Treat its dependents as `blocked` until its role leaves the parked group; it
   holds no slot.

When the human resolves it (a role change on the next fetch), emit `RESUME`; the
ticket returns to `available` per §2.3's park-resume rule. "Needs a human" is
**not** a new §2.3 role — it is `awaiting-external`/`paused` plus the graph's
`human-interactive` flag.

### 7. Milestone-review gate

For each `<milestone>` that is `ready-for-review="true"` **and**
`review-recorded="false"` with **no live** milestone-review agent: dispatch one
(milestone-keyed sentinel). Inputs: the milestone identifier and its project —
nothing more. The orchestrator MUST NOT perform the review itself and MUST NOT
advance any ticket gated on the milestone until the graph reports
`review-recorded` (gating is expressed as effective-blocking — gated tickets
never appear in `available`). The review agent solicits any human input as a
comment on the milestone's **review artifact**, tagging a human (never the
session); it may file follow-up tickets into the milestone, which re-block
advancement and reach the orchestrator only as a changed frontier
([`reference.md`](./reference.md#milestone-review-routing)).

### 8. Fill work (soft admission, §Slot ledger)

```
budget = number of FREE ledger entries observed at the START of this step
while budget > 0 AND startable work remains:
   next = first available, in priority order:
            (a) an injected bare PR,
            (b) a deferred-finalization parent whose subtasks are ALL
                verified/canceled (per the graph),
            (c) the highest-ranked <available> ticket with target-kind
                pr or verification
          (human-only tickets are handled at step 6, never dispatched)
   if no next: break
   dispatch a coordinator (§2.5) for next; budget -= 1
```

Take `<available>` ranks **as produced** — never re-rank. Dispatch **reserves no
ledger entry**: the coordinator and its delivery workers acquire their own as
they reach compute stages. Capping this tick's dispatches at the start-of-step
free count is the **soft admission** throttle; the atomic acquire stays the hard
bound (two coordinators admitted together still serialize at the ledger). Never
re-dispatch a unit that already holds a live (non-stale) lock — a second dispatch
races the first.

**Dispatch inputs** ([`reference.md`](./reference.md#ticket-coordinator-25)):
pass only what the unit needs — **never** ticket content. Ticket coordinator:
`ticket_id` + `ticket_url` (or, for a bare PR, `repo`/`pr_number`/`pr_url`/
`branch`), `target-kind`, any `branch-seed`, the §2.1 identity/mode context, and
the §2.3 hook responsibilities it owns. Require each dispatched unit to maintain
a heartbeated lock and to write an outcome artifact as its final action; mirror a
"working" signal on the forge/tracker where one is available.

### 9. Persist active set

Persist the active set atomically (coordinators + deferred-finalization +
human-blocked). The cursor was already persisted in step 1 — it has a single
source of truth. This MUST complete **before** the completion check, so the final
tick's cleanup and terminal transitions are never lost to an early stop.

### 10. Completion check

If **every** selected project's `<counts>` is `terminal="true"` (all tickets
`verified`, `canceled`, or `permanently-blocked`): **stop** (§Termination). Else
exit the tick (context released) and the next tick re-reads everything from disk.

### Tick conformance

- **Stateless across ticks** — the next tick re-reads graph cache, active set,
  locks, and ledger from disk; it carries nothing over in memory.
- **No detached background poll loop**, and never re-dispatch a unit with a live
  lock.
- **Isolate per-unit failures** — a producer error for one project, a
  closure-check failure for one PR: log `ERROR` and continue. One unit's failure
  MUST NOT starve the rest.

## Slot ledger

A **slot** is the right to perform local **compute** — write code, install,
build, or run tests — on the shared host. `MAX_PARALLEL` bounds how many agents
may be in such a stage at once. Slots are about **local compute, not
work-in-flight**: a PR merely open and awaiting CI/review/merge holds **no**
slot. On-disk layout, entry shape, and the acquire/release/reclaim discipline are
in [`reference.md`](./reference.md#slot-ledger). The orchestrator's
responsibilities:

- One **shared ledger** of `MAX_PARALLEL` entries is the single source of truth
  for the bound, drawn from by every computing agent — coordinators **and** the
  §2.4 delivery workers they spawn. A worker holds its own entry; a coordinator
  running several independent PRs holds one entry per concurrently-building worker.
- **Soft admission** (step 8) and **atomic acquire** (every computing agent) are
  distinct and MUST NOT be conflated: admission caps dispatch fan-out at the
  start-of-step free count and pre-reserves nothing; acquire is the binding bound.
- **Reclaim** (step 3) nulls any entry whose heartbeat is stale. Terminal cleanup
  MUST NOT force-release a live worker's entry. Because every wait releases the
  entry, nothing is permanently reserved — a milestone-review agent or a
  freshly-unblocked ticket always finds capacity as in-flight work idles.

## Deferred finalization

A `decomposed` coordinator outcome leaves the parent `in-progress` and
effectively blocked by its new subtasks (§2.5 Decomposition). Track the parent as
a **deferred-finalization** entry in the active set — neither `available` nor
owned by a live unit, holding no slot — and dispatch a finalizing coordinator for
it (step 8b) **only once** the graph reports every subtask `verified`/`canceled`.
This keeps an `in-progress` parent from being lost or re-dispatched in a loop
while its subtasks run.

## State and recovery

All state lives on disk or in the tracker/forge — never only in memory:

| State                  | Location                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| Durable graph + cursor | on-disk normalized cache                                                   |
| Active work set        | on-disk file (coordinators + deferred-finalization + human-blocked)        |
| Slot ledger            | on-disk, `MAX_PARALLEL` compute entries (shared by all agents)             |
| Liveness locks         | on-disk, ticket- or PR-keyed (coordinator) / milestone-keyed (review)      |
| Outcome artifacts      | on-disk, written by each dispatched unit                                   |
| Milestone summaries    | on-disk, written at milestone boundaries                                   |
| Ticket roles & history | the tracker (authoritative)                                                |
| PR terminal state      | the forge (authoritative)                                                  |

After a loss of on-disk state, recover from a **full producer sync** plus the
forge's open-PR list: missing locks mean no live units, and the next tick
re-dispatches as needed. Recovery MUST NOT depend on any in-memory counter.

## Credential modes

The orchestrator and the units it dispatches operate under §2.1 Mode A or Mode B,
which governs identity attribution and human-input routing — **not** how the
tracker is accessed. Mode selection follows §2.1. The producer adapter and the
access mechanism (API/CLI/MCP) are chosen independently by configuration; a given
mode places no constraint on access style, and access style is orthogonal to the
§2.1 mode.

## Log (§2.3)

Emit §2.3 operational log entries: `INFO` for dispatch, slot fill, cleanup, and
reassignment; `WAIT`/`RESUME` around human-blocked tickets being tracked; `ERROR`
for producer and tracker failures. Emit heartbeat `INFO` entries while the loop is
otherwise idle so observers can confirm liveness. Use a ticket `url` verbatim from
its node where one applies.

## Termination

Terminate — stop ticking and exit — when **either**:

- **every selected project's graph is terminal** (all tickets `verified`,
  `canceled`, or `permanently-blocked`, per `<counts>` `terminal="true"`); or
- **the operator explicitly instructs it to stop**, acknowledged per §2.1.

MUST NOT terminate merely because every compute slot is held, the available
frontier is momentarily empty while work is in flight, a milestone completed, or a
human handoff is outstanding. Resuming is by **re-invocation**; the new run reads
state from disk and the tracker and continues.

## Config

From the plugin's `userConfig` (env `CLAUDE_PLUGIN_OPTION_*`), forwarded to every
dispatched unit:

| key                 | effect                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `operator_login`    | operator's GitHub login; forwarded to coordinators, used for §2.1 routing. Required.          |
| `tracker`           | **default** tracker (default `linear`); all selected projects share one tracker (§2.3).      |
| `worktree_base`     | forwarded through coordinators to `deliver` (per-PR worktrees). Default `~/.worktrees`.       |
| `team_mode`         | forwarded through coordinators to `deliver` (review shape). Default `false`.                  |
| `copilot_available` | forwarded through coordinators to `deliver`. Default `true`.                                  |

The producer adapter, `MAX_PARALLEL`, the state root, and the staleness threshold
are implementation/configuration details; the producer adapter is selected
independently of the §2.1 mode (§Credential modes).

See [`reference.md`](./reference.md) for the project-graph wire format, the slot
ledger layout, the dispatch inputs/lock keys/outcome vocabulary, and
milestone-review routing. The spec (§2.1/§2.3/§2.4/§2.5/§2.6) is authoritative
where they differ.
