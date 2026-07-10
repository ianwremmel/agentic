---
name: work-project
description: Drive one or more whole projects to completion across a merged dependency graph (§2.6 orchestration). A thin, graph-driven dispatcher — each invocation is one stateless tick that refreshes the graph via build-graph, dispatches a work-ticket coordinator per unblocked frontier item and a review agent per ready milestone, reconciles in-flight units, and exits. Run it on an interval with /loop to drive a project to completion. Owns the graph and the dispatch bookkeeping; owns nothing about an individual ticket or PR.
---

# work-project

Drive **one or more projects** to completion. The orchestrator (§2.6) is
deliberately thin: it owns the merged **dependency graph** and the **dispatch
bookkeeping** (which tickets are unblocked, which have a live owner, which
milestone is awaiting review) — and **nothing** about an individual ticket or PR.
It does not read ticket bodies, evaluate CI/reviews, run milestone reviews, or
drive PRs; each belongs to a lower tier.

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

## One invocation = one tick

An orchestration run spans hours or days and dozens of tickets — far more than one
context holds. So the orchestrator is **stateless**: **each invocation of this
skill is a single tick** that reads all state from disk and the tracker, acts
once, and exits. It keeps **no** state in memory across ticks — the next tick
re-reads everything from disk. That is what lets a multi-day run never accumulate
context.

**Drive the cadence with `/loop`.** Because a fresh invocation is what gives each
tick a clean context, repetition is delegated to the built-in `/loop` skill rather
than a hand-rolled loop:

```
/loop 5m /work-project <projects…>
```

Each firing is one tick in a fresh context. Run `/work-project <projects…>`
**once**, without `/loop`, to execute a single tick by hand (useful for
inspection or a one-shot advance). Do **not** sleep-loop inside a tick or poll in
the background — do one pass and exit; `/loop` owns the interval. When the
completion check passes, the tick reports terminal and the run stops looping
(§Termination).

## Guards

- **Plan-mode guard.** A tick dispatches subagents and mutates the tracker; it
  MUST NOT run in a read-only planning mode. If invoked in one, **decline** and
  tell the operator to re-invoke outside it.
- **Same-tracker.** All selected projects MUST live on one tracker (§2.3 forbids
  cross-tracker dependencies). Mixed trackers → `ERROR`.
- **Communication restriction (§2.3).** Assigned for the run, never solicit a
  session response or block on session input. Human input routes through the
  tracker/forge (§2.1), never the session. Progress/status to the session is fine.

## The tick — do these in order

Setup (when the run dir is absent): derive the **run key** from the sorted project
ids; create the run dir; initialize an empty active set and slot ledger. All paths
in [`reference.md`](./reference.md#on-disk-state).

**1. Refresh the graph.** Invoke [`build-graph`](../build-graph/SKILL.md) with the
project set, `doc_path`, the persisted `cursor`, `exclude` = in-flight ∪ done ∪
failed ids, and `top` = injected ids. It writes the project-graph **XML**. Read
only its **derived sections** and node tags — never re-derive blocking, ranking,
or cycles. On an `<anomalies>` entry: surface it; a `<cycle>` is illegal (§2.3) —
do not work around it.

**2. Drain the injection inbox.** An injected **ticket** becomes a graph node (the
next refresh pulls its ancestors); its id joins `top` so it ranks to the head. An
injected **PR** becomes a top-priority active-set entry driven by a **coordinator**
scoped to that PR. Injection **never preempts** in-flight work.

**3. Reconcile stale locks & slots.** Clear any coordinator/PR/milestone lock whose
heartbeat has aged past the staleness threshold (its unit is presumed dead and
re-dispatchable), and free any slot-ledger entry whose owner's heartbeat is stale,
so a crashed agent cannot leak capacity.

**4. Reconcile each active coordinator** by its outcome artifact if written, else
by liveness. Handle the §2.5 outcomes **exhaustively** per
[`reference.md`](./reference.md#coordinator-outcome-reconciliation): in short,
`verified`/`canceled`/`delivered` → cleanup + drop; `human-blocked` → drop (step 6
handles the park); `decomposed` → record a **deferred-finalization** parent;
`failed` verification+retryable → re-dispatch; `failed` verification+not-retryable
→ park the gate + surface; other `failed` → drop + surface. No outcome: terminal
work → cleanup; no live owner → re-dispatch the same coordinator; live owner →
nothing. Terminal cleanup is **cleanup only** (lock, "working" label, worktree,
artifact); never force-release a *live* worker's slot.

**5. Reconcile each milestone-review agent** (milestone-keyed). Review recorded →
clear it (the gate opens; gated tickets unblock on the next refresh). No live
owner → re-dispatch. Live owner → nothing.

**6. Honor human-blocked nodes** (graph `<human-blocked>` — explicit-signal and
worker-discovered parks). Ensure each is parked in `awaiting-external` (or `paused`
if the tracker lacks it), transitioning an explicit-signal node there per §2.3.
Ensure **exactly one** outstanding human alert (scan the routing venue first for
the `agent-human-alert:<orchestrator-id>` sentinel; post only if none). **Never
dispatch a coordinator** for it. `WAIT` on entry; its dependents stay blocked. See
§Human-blocked.

**7. Milestone-review gate.** For each milestone `ready-for-review` AND NOT
`review-recorded` with no live review agent: dispatch **one** milestone-review
agent (milestone-keyed). Never perform the review yourself; never advance a ticket
gated on the milestone until the graph reports `review-recorded`.

**8. Fill work** — gated on compute capacity. `budget` = free slot-ledger entries
**at the start of this step**. While `budget > 0` and startable work remains, pick
`next` in priority order: **(a)** an injected bare PR, **(b)** a
deferred-finalization parent whose subtasks are all `verified`/`canceled` (per the
graph), **(c)** the highest-ranked `<available>` ticket (`target-kind` `pr` or
`verification`). `human-only` is never dispatched (step 6 owns it). Dispatch a
coordinator for `next`; `budget -= 1`. **Dispatch reserves no slot** — the
coordinator and its workers acquire their own when they reach a compute stage.
Capping this tick's dispatches at the start-of-step free count keeps one tick from
over-admitting.

**9. Persist the active set** and cursor. Then **exit the tick** — do not wait on
dispatched units; the next `/loop` firing reconciles them.

**10. Completion check** (before exit). If the graph reports every project terminal
(`all-terminal`) → report done and **stop looping** (§Termination). Persist (step
9) before this check so the final tick's cleanup is never lost.

Isolate per-unit failures: a producer error for one project, or a check failure
for one PR, is logged and skipped — one unit's failure never starves the rest.

## Dispatching a coordinator

Dispatch a coordinator as a **background subagent** (the Agent tool with
[`work-ticket`](../work-ticket/SKILL.md), run in the background) so it **outlives
the tick** — it heartbeats its lock and writes its outcome artifact as its final
action, both of which the next tick reconciles (steps 3–4). The orchestrator does
not wait on it.

Pass only what the unit needs — **never ticket content**: `ticket_id` +
`ticket_url` (or, for a bare PR, the forge identity `repo`/`pr_number`/`pr_url`/
`branch`), `target-kind`, any `branch-seed` hint, the identity/mode context, and
the operator login. Forward the shared-ledger and lock/outcome paths so the unit's
liveness and slot draws land in the shared bookkeeping
([`reference.md`](./reference.md#env-forwarded-to-dispatched-units)). A
milestone-review agent gets the milestone id + project; it records the outcome on
the §2.3 review artifact and routes any human input through that artifact's
comments — never the session.

## Slot accounting

A **slot** is local **compute** capacity (write code / install / build / test),
bounded by `MAX_PARALLEL` in one shared on-disk ledger. Every agent that may
compute — coordinators and their `deliver` workers — draws from this one ledger;
the orchestrator itself **holds none** (it never computes). An open PR merely
awaiting CI/review/merge holds **no** slot.

The tick does **not** pre-reserve at dispatch. It gates *new dispatch* on the free
count (step 8, a soft admission check); a unit acquires its own entry before a
compute stage and releases it on any wait or exit. Stale entries are reclaimed by
heartbeat age (step 3), so nothing leaks. *(Making acquire/release atomic against
concurrent agents is a determinism task for a later scripting pass; the tick and
the units cooperate on the plain on-disk ledger until then.)*

## Human-blocked

A node is human-interactive when the graph marks it `human-interactive` (explicit
tracker signal) **or** a coordinator parked it in `awaiting-external`
(worker-discovered). Both converge on the same resting state; each tick the
orchestrator parks it, ensures **exactly one** outstanding alert — a §2.1 comment
whose first line is the `<!-- agent-reply:<orchestrator-id> -->` marker with a
durable `<!-- agent-human-alert:<orchestrator-id> -->` sentinel **inside** the body
(after the marker in Mode A, after the opening sparkle in Mode B), posted only if a
venue scan finds none — never dispatches a coordinator for it, and treats its
dependents as blocked. On resolution (a role change on the next refresh), emit
`RESUME`; the ticket returns to `available` per §2.3's park-resume rule.

"Needs a human" is **not** a new §2.3 role — it is `awaiting-external`/`paused`
plus the graph's `human-interactive` flag.

## State & recovery

All state lives on disk or in the tracker/forge, never only in memory — layout in
[`reference.md`](./reference.md#on-disk-state). After a loss of on-disk state, a
tick recovers from a full `build-graph` refresh + the forge's open-PR list: missing
locks mean no live units, and the tick re-dispatches as needed. Recovery MUST NOT
depend on any in-memory counter. *(The on-disk bookkeeping is maintained by the
tick directly today; hardening the concurrency-sensitive pieces — the ledger, the
locks — into scripts is a later determinism pass.)*

## Logging (§2.3)

Emit operational log one-liners: `INFO` for dispatch, slot fill, cleanup,
reassignment, and idle heartbeats; `WAIT`/`RESUME` around human-blocked tickets;
`ERROR` for producer/tracker failures and cycles. Format:
[`reference.md`](./reference.md#logging-23). The orchestrator writes no ticket
state itself — coordinators own all §2.3 transitions.

## Termination

A run is complete when **either** the graph reports every selected project terminal
(`all-terminal` — all tickets `verified`/`canceled`/permanently-blocked) **or** the
operator explicitly says stop (acknowledged per §2.1). On completion the tick
reports terminal and **stops the loop** (end `/loop`); it does not re-arm. A tick
does **not** treat "all slots held", "frontier momentarily empty while work is in
flight", "a milestone completed", or "a human handoff outstanding" as completion —
those just mean this tick dispatched nothing and the next one will pick up.

## Config

From the plugin's `userConfig` (env `CLAUDE_PLUGIN_OPTION_*`), forwarded to
dispatched units:

| key                       | effect                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `operator_login`          | operator identity; forwarded to every coordinator; used for §2.1 routing. Required. |
| `tracker`                 | selects the `build-graph` fetch for the project set. Default `linear`.              |
| `max_parallel`            | `MAX_PARALLEL` compute-slot ledger size. Default `3`.                               |
| `human_interactive_label` | tracker label/field marking a node `human-interactive`; forwarded to `build-graph`. |
| `worktree_base`           | forwarded to coordinators → `deliver` (per-PR worktrees). Default `~/.worktrees`.   |
| `team_mode`               | forwarded to `deliver` (review shape). Default `false`.                             |
| `copilot_available`       | forwarded to `deliver`. Default `true`.                                             |

See [`reference.md`](./reference.md) for the on-disk layout, the outcome
reconciliation table, forwarded env, and the log format. The spec
(§2.1/§2.3/§2.5/§2.6) is authoritative where they differ.
