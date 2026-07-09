---
name: work-project
description: Drive one or more whole projects to completion across a merged dependency graph (§2.6 orchestration). A thin, graph-driven dispatcher — it runs a stateless tick loop that refreshes the graph via build-graph, dispatches a work-ticket coordinator per unblocked frontier item and a review agent per ready milestone, accounts compute slots, reconciles locks and outcomes, and honors human-blocked/injected work until every project is terminal. Owns the graph and bookkeeping; owns nothing about an individual ticket or PR.
---

# work-project

Drive **one or more projects** to completion. The orchestrator (§2.6) owns almost
nothing: the merged **graph**, the **slot ledger**, coordinator dispatch and lock
reconciliation, and completion. It does **not** read ticket bodies, evaluate
CI/reviews, run milestone reviews, or drive PRs — each belongs to a lower tier.
Every tick it sheds context, so a multi-day run never accumulates state in memory.

**Three tiers.** This skill is the *orchestrator*. It dispatches
[`work-ticket`](../work-ticket/SKILL.md) **coordinators** (§2.5, one per work
item) and **milestone-review agents** (§2.3). A coordinator internally drives
[`deliver`](../deliver/SKILL.md) **workers** (§2.4, one per PR). The orchestrator
dispatches **only** coordinators and review agents — verification-only tickets and
injected bare PRs are *also* coordinators, so it stays a clean graph→coordinator
dispatcher with no per-kind special cases.

**Operator** = the human directing this run (its identity, or the invocation that
named the projects). Glossary, on-disk layout, dispatch contract, and log format:
[`reference.md`](./reference.md).

## Guards

- **Plan-mode guard.** The orchestrator dispatches subagents and runs a
  long-running loop; it MUST NOT operate in a read-only planning mode. If invoked
  in one, **decline** and instruct the operator to re-invoke outside it.
- **Same-tracker.** All selected projects MUST live on one tracker (§2.3 forbids
  cross-tracker dependencies). Mixed trackers → `ERROR`.
- **Communication restriction (§2.3).** Assigned for the run, never solicit a
  session response or block on session input for progress. Human input routes
  through the tracker/forge (§2.1), never the session. Progress/status to the
  session is fine.

## The tick loop

The orchestrator **is** the loop: foreground, sequential ticks in this turn.
Each tick is **stateless** — it reads all state from disk and the tracker, acts,
and exits; the next tick re-reads from disk rather than trusting memory. Between
ticks, `sleep` in the foreground (adaptive, never faster than once per minute;
emit heartbeat `INFO` while idle). Run until §Termination.

**Forbidden** (each strands the run): a **detached background poll loop**
(`run_in_background` while/until/nohup) — the process loops while the agent is
reaped; **ending the turn before termination** — "nothing to do right now" orphans
in-flight work; re-dispatching a unit that already holds a **live** lock — it
races the first. Resuming after an abnormal exit is by **re-invocation**; the new
run recovers from disk + a full producer sync + the forge's open-PR list.

## The tick — do these in order

Setup (first tick): derive the **run key** from the sorted project ids; create the
run dir; `slots init <MAX_PARALLEL>`. All paths and env in
[`reference.md`](./reference.md#on-disk-state).

**1. Refresh graph.** Invoke [`build-graph`](../build-graph/SKILL.md) with the
project set, `cache_path`, `doc_path`, and `exclude` = in-flight ∪ done ∪ failed
ids (+ `top` = injected ids). It fetches a delta (or full sync on first
run/recovery/cursor-gap) and rewrites the cache + document. Read only the
document's **derived sections** and node tags — never re-derive blocking, ranking,
or cycles. On an `anomalies` entry: surface it; a `cycle` is illegal (§2.3) — do
not work around it.

**2. Drain injection inbox.** `state inbox-drain`. An injected **ticket** becomes
a graph node (the next fetch pulls its ancestors); its id joins `top` so it ranks
to the head. An injected **PR** becomes a top-priority active-set entry driven by
a **coordinator** scoped to that PR. Injection **never preempts** in-flight work.

**3. Reconcile stale locks & slots.** `locks sweep <STALE_SEC>` clears dead
coordinator/PR/milestone locks (and any mirrored "working" label) — the unit is
presumed dead and re-dispatchable. `slots reclaim <STALE_SEC>` frees ledger
entries whose owner's heartbeat is stale, so a crashed agent can't leak capacity.

**4. Reconcile each active coordinator** by its outcome artifact if written, else
by liveness. Handle the §2.5 outcomes **exhaustively** per
[`reference.md`](./reference.md#coordinator-outcome-reconciliation). In short:
`verified`/`canceled`/`delivered` → cleanup + drop; `human-blocked` → drop (step
6 handles the park); `decomposed` → record a **deferred-finalization** parent;
`failed` verification+retryable → re-dispatch; `failed` verification+not-retryable
→ park the gate + surface; other `failed` → drop + surface. No outcome: terminal
work → cleanup; no live owner → re-dispatch the same coordinator; live owner →
nothing. Terminal cleanup is **cleanup only** (lock, label, worktree, artifact);
never force-release a *live* worker's slot.

**5. Reconcile each milestone-review agent** (milestone-keyed sentinel). Review
recorded → clean the sentinel (the gate opens; gated tickets unblock next fetch).
No live owner → re-dispatch. Live owner → nothing.

**6. Honor human-blocked nodes** (graph `human-blocked` — explicit-signal and
worker-discovered parks). Ensure each is parked in `awaiting-external` (or
`paused` if the tracker lacks it), transitioning an explicit-signal node there per
§2.3 if needed. Ensure **exactly one** outstanding human alert (scan the routing
venue first for the `agent-human-alert:<orchestrator-id>` sentinel; post only if
none). **Never dispatch a coordinator** for it. `WAIT` on entry; its dependents
stay blocked (a parked ticket holds no slot). See §Human-blocked.

**7. Milestone-review gate.** For each milestone `ready-for-review` AND NOT
`review-recorded` with no live review agent: dispatch **one** milestone-review
agent (milestone-keyed sentinel). Never perform the review yourself; never advance
a ticket gated on the milestone until the graph reports `review-recorded`.

**8. Fill work** — gated on compute capacity. `budget = slots free-count` **at the
start of this step**. While `budget > 0` and startable work remains, pick `next`
in priority order: **(a)** an injected bare PR, **(b)** a deferred-finalization
parent whose subtasks are all `verified`/`canceled` (per the graph), **(c)** the
highest-ranked `available` ticket (`target-kind` `pr` or `verification`).
`human-only` is never dispatched (step 6 owns it). Dispatch a coordinator for
`next`; `budget -= 1`. **Dispatch reserves no ledger entry** — the coordinator and
its workers acquire their own atomically at compute stages. Capping dispatches at
the start-of-step free count keeps one tick from over-admitting; the atomic
acquire is the hard bound.

**9. Persist the active set** atomically (`state put active-set`). The cursor was
already persisted inside the graph cache in step 1 — single source of truth.

**10. Completion check.** If every project's `counts` are terminal
(`all_terminal`) → **stop** (§Termination). Else sleep, then start the next tick.
Persistence (step 9) MUST complete before this check, so the final tick's cleanup
and terminal transitions are never lost to an early stop.

Isolate per-unit failures: a producer error for one project or a check failure for
one PR is logged and skipped — one unit's failure never starves the rest.

## Dispatch contract

Dispatch a coordinator as a **subagent** ([`work-ticket`](../work-ticket/SKILL.md)
via the Agent tool). Pass only what the unit needs to act — **never ticket
content**: `ticket_id` + `ticket_url` (or, for a bare PR, the forge identity
`repo`/`pr_number`/`pr_url`/`branch`), `target-kind`, any `branch_seed` hint, the
identity/mode context, and the operator login. Forward the shared-ledger and
lock/outcome env so the unit's liveness and slot draws are visible
([`reference.md`](./reference.md#env-forwarded-to-dispatched-units)). A
milestone-review agent gets the milestone id + project; it records the outcome on
the §2.3 review artifact and routes any human input through that artifact's
comments — never the session.

Each dispatched unit MUST maintain a **lock** (ticket-/PR-/milestone-keyed,
heartbeated) and write an **outcome artifact** as its final action, and mirror a
"working" signal on the forge/tracker where available. The orchestrator reconciles
off those (step 4/5) and reads the coordinator's outcome per §2.5 §Reporting.

## Slot accounting

A **slot** is local **compute** capacity (write code / install / build / test),
bounded by `MAX_PARALLEL` in one shared on-disk ledger (`scripts/slots`). Every
agent that may compute — coordinators and their `deliver` workers — draws from
this one ledger; the orchestrator itself **holds none** (it never computes). An
open PR merely awaiting CI/review/merge holds **no** slot.

The orchestrator does **not** pre-reserve at dispatch. It gates *new dispatch* on
`slots free-count` (step 8, a soft admission check); the binding bound is each
agent's atomic `slots acquire` before a compute stage. Two coordinators admitted
in one tick still serialize at the ledger. Stale entries are reclaimed by
heartbeat age (step 3), so nothing leaks; because every wait releases the entry,
nothing is permanently reserved and a freshly-unblocked ticket always finds
capacity as in-flight work idles.

## Human-blocked

A node is human-interactive when the graph marks it `human-interactive` (explicit
tracker signal) **or** a coordinator parked it in `awaiting-external`
(worker-discovered). Both converge on the same resting state; each tick the
orchestrator: parks it (transitioning an explicit-signal node there per §2.3);
ensures **exactly one** outstanding alert — a §2.1 comment whose first line is the
`<!-- agent-reply:<orchestrator-id> -->` marker with a durable
`<!-- agent-human-alert:<orchestrator-id> -->` sentinel **inside** the body (after
the marker in Mode A, after the opening sparkle in Mode B), posted only if a venue
scan finds none unresolved; never dispatches a coordinator for it; treats its
dependents as blocked. On resolution (a role change on the next fetch), emit
`RESUME`; the ticket returns to `available` per §2.3's park-resume rule.

"Needs a human" is **not** a new §2.3 role — it is `awaiting-external`/`paused`
plus the graph's `human-interactive` flag.

## Anomalies

`cycle` is illegal (§2.3): surface it to the operator and to the log (`ERROR`);
do **not** silently work around it or dispatch into it. `cross-project-edge` is
informational (same-tracker cross-project deps are honored) — surface once.

## State & recovery

All state lives on disk or in the tracker/forge, never only in memory — see the
layout in [`reference.md`](./reference.md#on-disk-state). After a loss of on-disk
state, recover from a full producer sync + the forge's open-PR list: missing locks
mean no live units, and the next tick re-dispatches as needed. Recovery MUST NOT
depend on any in-memory counter.

## Logging (§2.3)

Emit operational log one-liners: `INFO` for dispatch, slot fill, cleanup,
reassignment, and idle heartbeats; `WAIT`/`RESUME` around human-blocked tickets;
`ERROR` for producer/tracker failures and cycles. Format:
[`reference.md`](./reference.md#logging-23).

## Termination

Stop ticking and exit when **either** every selected project's graph is terminal
(`counts.all_terminal` — all tickets `verified`/`canceled`/permanently-blocked)
**or** the operator explicitly says stop (acknowledged per §2.1). Do **not**
terminate merely because all slots are held, the frontier is momentarily empty
while work is in flight, a milestone completed, or a human handoff is outstanding.
Resuming is by re-invocation.

## Config

From the plugin's `userConfig` (env `CLAUDE_PLUGIN_OPTION_*`), forwarded to
dispatched units:

| key                       | effect                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `operator_login`          | operator identity; forwarded to every coordinator; used for §2.1 routing. Required.          |
| `tracker`                 | selects the `build-graph` producer adapter for the project set. Default `linear`.            |
| `max_parallel`            | `MAX_PARALLEL` compute-slot ledger size. Default `3`.                                         |
| `human_interactive_label` | tracker label/field marking a node `human-interactive`; forwarded to `build-graph`.          |
| `worktree_base`           | forwarded to coordinators → `deliver` (per-PR worktrees). Default `~/.worktrees`.             |
| `team_mode`               | forwarded to `deliver` (review shape). Default `false`.                                       |
| `copilot_available`       | forwarded to `deliver`. Default `true`.                                                       |

See [`reference.md`](./reference.md) for the on-disk layout, the outcome
reconciliation table, forwarded env, and the log format. The spec
(§2.1/§2.3/§2.5/§2.6) is authoritative where they differ.
