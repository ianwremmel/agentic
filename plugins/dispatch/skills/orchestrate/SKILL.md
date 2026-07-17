---
name: orchestrate
description: Drive one or more tracker projects to completion — refresh the dependency graph via build-graph, dispatch work-ticket coordinators across the unblocked frontier, gate milestones on reviews, park human-only work. Use when the unit of work is a whole project (or several), not one ticket.
---

# orchestrate

You own dispatch — nothing else. Never read a ticket body, evaluate CI/review
state, or run a milestone review yourself; coordinators
([`work-ticket`](../work-ticket/SKILL.md)) and milestone-review agents do that.
All state lives in the graph store (the `dispatch graph` CLI) and the tracker:
you keep no files and carry nothing in memory between ticks.

**Plan mode is incompatible** — this skill dispatches subagents and writes
state. If invoked in a read-only planning mode, decline and ask the operator to
re-invoke outside it.

You are bound by the **communication restriction**: human input routes through
the tracker (alerts on tickets, questions on review artifacts), never by
blocking on session input. Status reports to the session are fine. Wire format
and Mode A/B: [`deliver/reference.md`](../deliver/reference.md).

Inputs: the projects to drive (tracker + names/ids). Concurrency is the graph
config's `maxParallel` (the slot-ledger size).

## The loop

Drive the ticks with the host's `/loop` (self-paced, per the
[cadence](./reference.md#cadence)): each firing runs one tick and ends the
turn. A stopped loop resumes by re-invoking — every decision re-derives from
the store.

## The tick

1. **Refresh** — dispatch a subagent running
   [`build-graph`](../build-graph/SKILL.md) for the selected projects.
2. **Read** — `dispatch graph summary`; everything below acts on its sections.
3. **Anomalies** — surface each `<anomaly>` to the operator; never work around
   one (a cycle is illegal).
4. **Human-blocked** — for each `<human-blocked>` ticket: ensure it is parked
   (`awaiting-external`, else `paused`), ensure **exactly one** open alert
   (scan for the sentinel first; [rules](./reference.md#human-alerts)), and
   never dispatch for it. Log `WAIT` when it parks; `RESUME` when a later
   summary shows its role left the parked group.
5. **Failures** — each `<failures>` ticket is parked, non-retryable work:
   alert the operator on the ticket (same
   [alert rules](./reference.md#human-alerts); `ERROR` log). Recovery is
   tracker-side: moving the ticket back to ready requeues it (the refresh
   clears the record); canceling it ends it.
6. **Dispatch** — `dispatch graph fill`. The CLI performs every state step —
   free-slot arithmetic, agent-id minting, claim and review-lock acquisition —
   and prints the tick's dispatch list, claims already taken. For each
   `<review>`: dispatch a [`milestone-review`](../milestone-review/SKILL.md)
   subagent ([inputs](./reference.md#milestone-review-agent)) under its `agent`
   id. For each `<ticket>`: dispatch a background `work-ticket` subagent with
   the [dispatch inputs](./reference.md#dispatch-inputs) — the element's
   attributes, never ticket content. An empty `<dispatches/>` means nothing
   dispatchable right now, not done.
7. **Exit check** — stop the loop only when the summary reads
   `<summary terminal="true">` — the CLI folds project counts, queue depth,
   live claims, and milestone gates into that one attribute — or the operator
   says stop.

Re-dispatch falls out of the store — you reconcile nothing by hand. A crashed
coordinator's claim goes stale and its item comes back through `next` as a
`resume`; a finished coordinator's outcome either ends the item or re-queues
it as a follow-up pass (verify, finalize, retry).

## Capacity

A slot is a compute permit (write code, install, build, test), acquired and
released by the workers themselves (`dispatch graph slot …`). `fill` admits
tickets up to the free-slot count — *admission* only; the atomic acquire is the
hard bound, so over-admission never overloads the host. A ticket merely
awaiting CI, review, or a human holds no slot.

## Injection

Mid-run work arrives through the store, never a file. A ticket: have the next
refresh fetch and write it with `--injected`. A ticketless PR:
`dispatch graph pr add --repo o/r --pr 7 --url …`. Both rank to the head of the
queue and preempt nothing in flight.

## Logging

`INFO` for dispatch and cleanup; `WAIT`/`RESUME` around human-blocked tickets;
`ERROR` for producer or tracker failures and surfaced failed work. Format:
[`work-ticket/reference.md`](../work-ticket/reference.md#logging).
