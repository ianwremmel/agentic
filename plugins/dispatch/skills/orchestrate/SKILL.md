---
name: orchestrate
description: Drive one or more tracker projects to completion — refresh the dependency graph via build-graph, dispatch work-ticket coordinators across the unblocked frontier, gate milestones on reviews, park human-only work. Use when the unit of work is a whole project (or several), not one ticket.
---

# orchestrate

Drive the selected projects to completion as a **graph-driven dispatcher**. You
own the graph, the bookkeeping, and dispatch — nothing else. Never read a ticket
body, evaluate CI/review state, or run a milestone review yourself; coordinators
([`work-ticket`](../work-ticket/SKILL.md)) and milestone-review agents do that.
Act only on `dispatch graph doc` output and the on-disk artifacts below.

**Plan mode is incompatible** — this skill dispatches subagents and writes
state. If invoked in a read-only planning mode, decline and ask the operator to
re-invoke outside it.

You are assigned for the run and bound by the **communication restriction**:
human input routes through the tracker (alerts on tickets, questions on review
artifacts), never by blocking on session input. Status reports to the session
are fine. Wire format and Mode A/B:
[`deliver/reference.md`](../deliver/reference.md).

## Setup

- **Inputs**: the projects to drive (tracker + names/ids) and optionally
  `max-parallel` (default 3) — the most coordinators live at once.
- **Paths**: `<cache>` =
  `${DISPATCH_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dispatch}`. Inbox
  `<cache>/orchestrate/inbox/`, review sentinels `<cache>/orchestrate/reviews/`,
  coordinator artifacts `<cache>/work-ticket/<key>/` (their shapes are
  [`work-ticket`'s](../work-ticket/reference.md#dispatch-artifacts)).

## The tick

Run as **stateless ticks**: every decision derives from `dispatch graph doc`
and the files above, nothing from memory — a re-invocation after a crash reads
the same state and continues. Each tick, in order:

1. **Inbox** — read `<cache>/orchestrate/inbox/*.json`
   ([shapes](./reference.md#injection-inbox)). Ticket entries feed step 2; PR
   entries become top-priority coordinator dispatches at step 7. Injection
   never preempts or reclaims from work already in flight.
2. **Refresh** — dispatch a subagent running
   [`build-graph`](../build-graph/SKILL.md) for the selected projects (it
   deltas off the stored cursor; first run is a full sync), telling it to also
   fetch any inbox tickets and write them with `--injected`. Delete each inbox
   ticket file once written.
3. **Read** — `dispatch graph doc --format xml`. The derived sections are
   authoritative — never re-derive blocking, ranking, or readiness. Surface
   every `<anomaly>` to the operator and do not work around it (a cycle is
   illegal).
4. **Reconcile** each active coordinator — every `<cache>/work-ticket/<key>/`
   and every in-flight node with a claim — per the
   [outcome table](./reference.md#reconcile). In short: terminal outcome →
   clean up and drop; `delivered` → re-dispatch to verify; `decomposed` → hold
   for finalization; `failed` → retry only a retryable verification, else
   surface to the operator; no outcome and a stale claim → re-dispatch; live
   claim → leave it alone. Never re-dispatch over a live claim.
5. **Human-blocked** — for each `<human-blocked>` ticket: ensure it is parked
   (`awaiting-external`, else `paused`), ensure **exactly one** open alert
   (scan the ticket for the `<!-- agent-human-alert:dispatch -->` sentinel
   before posting; [alert rules](./reference.md#human-alerts)), and never
   dispatch a coordinator for it. Log `WAIT` when it parks; when a fetch shows
   its role left the parked group, log `RESUME` — it re-enters the frontier by
   itself.
6. **Milestone gates** — for each `<milestone ready-for-review="true"
   review-recorded="false"/>` with no live review sentinel: dispatch a
   milestone-review agent ([brief](./reference.md#milestone-review-agent)).
   When the doc shows `review-recorded="true"`, delete the sentinel.
7. **Fill** — capacity = `max-parallel` − live coordinators − live review
   agents. While capacity > 0, dispatch the first of:
   1. an inbox PR (record it under `<cache>/work-ticket/<repo>#<n>/` first);
   2. a `decomposed` parent whose subtasks are all `verified`/`canceled` in
      the doc — a finalization pass;
   3. `dispatch graph next --claim --agent <id>` with a freshly minted id
      (`wt-<epoch>-<n>`) — empty output means no dispatchable work right now,
      not done.

   Dispatch each as a background `work-ticket` subagent with the
   [dispatch inputs](./reference.md#dispatch-inputs) — ids, urls, kind, hints,
   the claim agent id — never ticket content.
8. **Exit check** — terminate only when every selected project has
   `terminal="true"` in `<counts>` (partial projects don't count) and no
   coordinator or review agent is live, or the operator says stop. An empty
   frontier with work in flight, an outstanding human handoff, or a milestone
   awaiting review all mean **keep ticking**. Otherwise sleep per the
   [cadence](./reference.md#cadence) and tick again.

Run the loop yourself with foreground `sleep` between ticks, exactly like
`deliver`: no detached background poll loops, never end the turn mid-run.
Subagent completion notices are advisory — the next tick reads disk regardless.

## Capacity

There is no compute-slot ledger yet; the bound is dispatch-granular: at most
`max-parallel` live coordinators. Coordinators keep their own draw small by
running PRs sequentially (their default). A ticket that is merely open —
awaiting CI, review, or a human — still counts while its coordinator lives;
prefer a `max-parallel` sized for concurrent *builds* on this host.

## Logging

Emit `INFO` for dispatch, cleanup, and heartbeats while idle; `WAIT`/`RESUME`
around human-blocked tickets; `ERROR` for producer or tracker failures. Format:
[`work-ticket/reference.md`](../work-ticket/reference.md#logging).
