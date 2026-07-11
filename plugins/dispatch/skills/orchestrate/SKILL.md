---
name: orchestrate
description: Drive one or more whole projects to completion across a dependency graph — refresh the graph, dispatch a work-ticket coordinator per unblocked ticket, gate milestones on review, honor human handoffs, and tick until every project is terminal. Use when the unit of work is a project (or several), not a single ticket.
---

# orchestrate

Drive whole projects by **dispatching, not doing**. Never read a ticket body,
judge CI or reviews, or run a milestone review — a coordinator or a reviewer does
that.

Three skills do the work you coordinate:

- [`build-graph`](../build-graph/SKILL.md) — the producer. Your only view of the
  tracker: it fetches, merges, and derives the graph you schedule from.
- [`work-ticket`](../work-ticket/SKILL.md) — a coordinator, one per work item. A
  verification ticket and an injected bare PR are coordinators too.
- [`review-milestone`](../review-milestone/SKILL.md) — a reviewer, one per
  ready-for-review milestone.

You dispatch the last two. Terms and shapes: [`reference.md`](./reference.md).

## Guards

Stop before doing anything if:

- **Read-only/plan mode.** Decline and tell the operator to re-invoke outside it.
- **Mixed trackers.** All selected projects must live on one tracker.

## Run directory

All state is on disk.

```
DISPATCH_RUN_DIR=${DISPATCH_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dispatch}/orchestrate/<run-id>
dispatch-state init
```

`<run-id>` is a stable slug of the selected projects — re-invoking resumes the
same run. Export `DISPATCH_RUN_DIR` to every agent you dispatch. Layout and
commands: [`reference.md`](./reference.md#run-directory).

## The tick

Each tick is a **fresh subagent** that reads state from disk and the tracker,
decides, and returns a short action list; you execute it and sleep. Your own
context holds only the run dir and the last tick's summary.

Tick brief, in order:

1. **Refresh the graph.** Invoke [`build-graph`](../build-graph/SKILL.md) with the
   projects and the run dir. It reads the cursor and the active set itself and
   writes `document.xml`.
2. **Drain the queue** (`dispatch-state inbox drain`) — work added mid-run
   ([`reference.md`](./reference.md#injection)). Record an injected ticket with
   `inject add <id>` (the next fetch pulls it in and ranks it first); record an
   injected PR with `unit put <key> pending`.
3. **Sweep** (`lock sweep`, `slot reap`).
4. **Reconcile each `dispatched` unit** by its outcome artifact, else by liveness
   — table in [`reference.md`](./reference.md#reconciling-a-coordinator). Units in
   any other state are not re-dispatched; they stay recorded, so they stay out of
   `<available>`.
5. **Reconcile each milestone reviewer** — outcome `recorded` ⇒ clear the
   sentinel; `failed` ⇒ surface, no re-dispatch; `awaiting-input` or no live owner
   ⇒ re-dispatch (a fresh reviewer finds its own open request and waits again).
6. **Honor `<human-blocked>`.** Never dispatch a coordinator for one. Ensure it is
   parked in `awaiting-external`, and that **exactly one** alert is open (scan the
   venue first); re-check next tick.
7. **Gate milestones.** For each milestone `ready-for-review` and not
   `review-recorded` with no live reviewer, dispatch
   [`review-milestone`](../review-milestone/SKILL.md) under a milestone-keyed
   lock. Never advance a ticket the graph still reports blocked.
8. **Fill work.** `budget = dispatch-state slot free` at the start of this step.
   While `budget > 0`, dispatch a coordinator for the next unit in priority order —
   (a) injected PR, (b) a `deferred` parent whose subtasks are all
   `verified`/`canceled`, (c) the first ticket in `<available>` — and decrement.
   Dispatch reserves no ledger entry.
9. **Report** (below) and check termination. State is already durable — every
   `dispatch-state` command committed as it ran.

Per-unit failures are isolated: log and continue.

## Report each tick

Print one table:

```
| Ticket | Title              | Role        | PR   | State            |
| ------ | ------------------ | ----------- | ---- | ---------------- |
| DEV-12 | Add the schema     | in-progress | #7   | building         |
| DEV-13 | Wire the endpoint  | available   | —    | blocked: DEV-12  |
```

Ticket and PR cells link out (the graph node carries `url` and any `pr`). Title,
role, and blockers all come from `document.xml` — never from a ticket body. Cover
everything in flight, plus what is blocked, human-blocked, and stalled. Follow it
with the counts, and name any anomaly.

## Rules the tick cannot break

- **The derived sections are authoritative.** Never re-derive blocking, ranking,
  or cycles, and never work around an `<anomaly>` — surface it.
- **One live unit per key.** Never dispatch against a live (non-stale) lock.
- **Never preempt.** Injected work is dispatched ahead of lower-ranked tickets at
  the next tick with free capacity, never by reclaiming a running unit.
- **Persist before you stop.**
- **Slots bound local compute.** Work waiting on CI, a review, or a human holds
  none. Every computing agent — coordinators and their delivery workers — acquires
  and releases its **own** entry. A full ledger (`DISPATCH_MAX_PARALLEL` =
  `${user_config.max_parallel}`) is the only reason to hold back a dispatch.
- **You write to the tracker exactly twice**: the park transition and the human
  alert on a human-blocked ticket. Everything else you know comes from the
  producer.

## Cadence

A run spans days, so drive the ticks with
[`/loop`](https://code.claude.com/docs/en/slash-commands) rather than holding one
turn open: `/loop 5m /dispatch:orchestrate <projects>` (omit the interval to let
the model pace itself). Without `/loop`, tick inline with a foreground `sleep` —
60 s while units converge, stretching toward 5 min when a tick changes nothing —
and never a detached background loop.

## Termination

Stop only when `terminal` is true on every selected project's `<counts>`, or the
operator says stop. A momentarily empty frontier, a full ledger, a completed
milestone, a non-empty `<stalled>`, and an outstanding human handoff are waits,
not termination. End the loop (`/loop` stop) only on termination.

## Log

`INFO` on dispatch, cleanup, sweep, and idle heartbeats; `WAIT`/`RESUME` around
human-blocked tickets; `ERROR` on producer and tracker failures. Format:
[`work-ticket/reference.md`](../work-ticket/reference.md#logging).
