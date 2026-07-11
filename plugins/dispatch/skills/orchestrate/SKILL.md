---
name: orchestrate
description: Drive one or more whole projects to completion across a dependency graph — refresh the graph, dispatch a work-ticket coordinator per unblocked ticket, gate milestones on review, honor human handoffs, and tick until every project is terminal. Use when the unit of work is a project (or several), not a single ticket.
---

# orchestrate

Drive whole projects by **dispatching, not doing**. Never read a ticket body,
judge CI or reviews, or run a milestone review — a coordinator or a reviewer does
that.

You dispatch two unit kinds: a [`work-ticket`](../work-ticket/SKILL.md)
coordinator and a [`review-milestone`](../review-milestone/SKILL.md) reviewer. A
verification ticket and an injected bare PR are both coordinators.

Terms and shapes: [`reference.md`](./reference.md).

## Guards

Stop before doing anything if:

- **Read-only/plan mode.** You dispatch subagents and run for days. Decline and
  tell the operator to re-invoke outside it.
- **Mixed trackers.** All selected projects must live on one tracker.

## Run directory

All state is on disk.

```
DISPATCH_RUN_DIR=${DISPATCH_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dispatch}/orchestrate/<run-id>
scripts/dispatch-state init
```

`<run-id>` is a stable slug of the selected projects — re-invoking resumes the
same run. Export `DISPATCH_RUN_DIR` to every agent you dispatch. Layout and
commands: [`reference.md`](./reference.md#run-directory).

## The tick

Each tick is a **fresh subagent** that reads state from disk and the tracker,
decides, and returns a short action list; you execute it and sleep. Your own
context holds only the run dir and the last tick's one-line summary.

Tick brief, in order:

1. **Refresh the graph.** Invoke [`build-graph`](../build-graph/SKILL.md) with
   the run's `cache`, the persisted `cursor`, `--exclude` every `active keys` id,
   and `--priority` every `active injected` id. Full sync instead of a delta on
   first run, after recovery, or on a cursor gap.
2. **Drain the inbox** (`inbox drain`). Record an injected ticket with
   `active inject <id>` — the graph pulls it in on the next fetch and ranks it to
   the top. Record an injected PR as an active entry, `state: pending`.
3. **Sweep** (`lock sweep`, `slot reap`).
4. **Reconcile each `dispatched` active entry** by its outcome artifact, else by
   liveness — table in [`reference.md`](./reference.md#reconciling-a-coordinator).
   Entries in any other state are not re-dispatched; they stay in the active set
   so they stay out of `available`.
5. **Reconcile each milestone reviewer** — outcome `recorded` ⇒ clear the
   sentinel; `failed` ⇒ surface, no re-dispatch; `awaiting-input` or no live
   owner ⇒ re-dispatch (a fresh reviewer finds its own open request and waits
   again).
6. **Honor `human_blocked`.** Never dispatch a coordinator for one. Ensure it is
   parked in `awaiting-external`, and that **exactly one** alert is open (scan
   the venue first); re-check next tick.
7. **Gate milestones.** For each milestone `ready_for_review` and not
   `review_recorded` with no live reviewer, dispatch
   [`review-milestone`](../review-milestone/SKILL.md) under a milestone-keyed
   lock. Never advance a ticket the graph still reports blocked.
8. **Fill work.** `budget = slot free` at the start of this step. While
   `budget > 0`, dispatch a coordinator for the next unit in priority order —
   (a) injected PR, (b) a `deferred` parent whose subtasks are all
   `verified`/`canceled`, (c) the highest-ranked `available` ticket — and
   decrement. Dispatch reserves no ledger entry.
9. **Persist** the active set. Then check completion: `counts.terminal` on every
   project ⇒ done.

Per-unit failures are isolated: log and continue. An idle tick with a non-empty
`stalled` list means work is waiting on a human somewhere else (`backlog`,
`paused`) — name those ids in the heartbeat rather than reporting "nothing to
do".

## Rules the tick cannot break

- **The derived sections are authoritative.** Never re-derive blocking, ranking,
  or cycles, and never work around an `anomaly` — surface it.
- **One live unit per key.** Never dispatch against a live (non-stale) lock.
- **Never preempt.** Injected work is dispatched ahead of lower-ranked tickets at
  the next tick with free capacity, never by reclaiming a running unit.
- **Persist before you stop.**
- **Slots bound local compute, not work in flight.** Work waiting on CI, a
  reviewer, or a human holds no slot. Every agent that computes — coordinators
  and the delivery workers they spawn — acquires and releases its **own** entry;
  never release one on another agent's behalf. The ledger
  (`DISPATCH_MAX_PARALLEL` = `${user_config.max_parallel}`) is the one bound for
  the host, and a full ledger is the only reason to hold back a dispatch.
- **You write to the tracker exactly twice**: the park transition and the human
  alert on a `human_blocked` ticket. Everything else you know about the tracker
  comes from the producer.

## Dispatch

Dispatch each unit as a **background subagent** so it outlives the tick that
started it, with `DISPATCH_RUN_DIR` exported. Pass identity/mode and only what
the unit needs to act — **never ticket content**; the coordinator fetches its own
brief. Inputs and artifacts: [`reference.md`](./reference.md#dispatch).

## Cadence

Tick every 60 s while units are converging; stretch toward 5 min when a tick
changes nothing. Foreground `sleep` between ticks — never a detached background
loop, and never end the turn before termination.

## Termination

Stop only when `counts.terminal` is true on every selected project, or the
operator says stop. A momentarily empty frontier, a full ledger, a completed
milestone, a non-empty `stalled` list, and an outstanding human handoff are
waits, not termination.

## Log

`INFO` on dispatch, cleanup, sweep, and idle heartbeats; `WAIT`/`RESUME` around
human-blocked tickets; `ERROR` on producer and tracker failures. Format:
[`work-ticket/reference.md`](../work-ticket/reference.md#logging).
