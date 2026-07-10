# work-project — reference

Lookup tables for [`SKILL.md`](./SKILL.md), bundled so the skill is
self-contained. The spec is authoritative where they differ: §2.1 Communication,
§2.3 Ticket Workflow, §2.5 Ticket Coordination, §2.6 Orchestration.

## Roles

- **orchestrator** — this skill. Each invocation is one tick. Owns the merged
  graph and the dispatch bookkeeping; reads only the derived graph document, never
  a raw ticket body, CI/review state, or a milestone review.
- **coordinator** — a [`work-ticket`](../work-ticket/SKILL.md) (§2.5) background
  subagent, one per work item (ticket, no-PR verification, or injected bare PR).
- **delivery worker** — a [`deliver`](../deliver/SKILL.md) (§2.4) instance a
  coordinator spawns, one per PR; draws a compute slot from the shared ledger.
- **milestone-review agent** — dispatched for a milestone ready-for-review; records
  the §2.3 review outcome, routes human input through the review artifact.
- **producer** — [`build-graph`](../build-graph/SKILL.md) (§2.6); emits the
  project-graph XML each tick.
- **operator** — the human directing the run; identity is `operator_login`.

## Cadence: `/loop`

Each invocation of `/work-project` is a single tick that reads disk + tracker,
acts once, and exits. The repetition — and the fresh context that makes each tick
stateless — comes from the built-in `/loop` skill:

```
/loop 5m /work-project PROJ-A PROJ-B
```

`/work-project PROJ-A` on its own runs exactly one tick. On completion a tick stops
the loop; the operator can also stop it at any time.

## On-disk state

Base: `${DISPATCH_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dispatch}/work-project/<run-key>/`.
`<run-key>` = a stable slug of the sorted selected project ids, so the same project
set resumes the same run. Nothing authoritative lives only in memory (§2.6); the
tick maintains these files directly (hardening the concurrency-sensitive ones into
scripts is a later determinism pass).

| path             | holds                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| `graph.xml`      | the project-graph document `build-graph` writes; read each tick (+ cursor) |
| `active-set`     | active coordinators + deferred-finalization parents + human-blocked ids    |
| `ledger`         | `MAX_PARALLEL` compute entries, shared by all agents; owner + heartbeat    |
| `locks/<key>`    | ticket-/PR-/milestone-keyed liveness locks (agent id + heartbeat)          |
| `inbox/`         | injection inbox (tickets/PRs injected mid-run)                             |
| `outcomes/<key>` | outcome artifact each dispatched unit writes as its final action           |

Keys are slugged for the filesystem: a ticket key is its id (`DEV-123`); a bare-PR
key is `<owner>__<repo>__<pr_number>`; a milestone key is `mile__<milestone-id>`.

## Env forwarded to dispatched units

Set in each dispatched agent's environment so its slot draws and liveness land in
the shared bookkeeping. (The `work-ticket`/`deliver` seams that consume the
ledger/lock env are wired incrementally — their current in-skill seams are declared
stubs/no-ops; §2.6 owns these real paths.)

| env                                             | meaning                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `DISPATCH_LEDGER`                               | shared compute-slot ledger path. Every computing agent draws here. |
| `DISPATCH_LOCK_DIR`                             | lock registry dir; the unit heartbeats its own `<key>` lock.       |
| `DISPATCH_OUTCOME_PATH`                         | path the unit writes its outcome artifact to (its final action).   |
| `DISPATCH_CACHE_DIR`                            | dispatch cache base (so all tiers agree on locations).             |
| `DISPATCH_OPERATOR_LOGIN`                       | operator login (also `CLAUDE_PLUGIN_OPTION_OPERATOR_LOGIN`).       |
| `worktree_base`/`team_mode`/`copilot_available` | forwarded through to `deliver` (§2.4).                             |

## Coordinator outcome reconciliation

Tick step 4, handled exhaustively (§2.6). "cleanup" = clear the lock, the "working"
label, any worktree, and the outcome artifact — **never** force-release a live
worker's slot (stale reclamation handles a straggler).

| outcome artifact                       | action                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `verified` \| `canceled`               | cleanup + drop (terminal; the coordinator already made the §2.3 transitions)                                       |
| `delivered`                            | cleanup + drop; a separate verification work item takes the ticket to `verified`                                   |
| `human-blocked`                        | cleanup + drop; the parked ticket is handled at step 6                                                             |
| `decomposed`                           | cleanup; record the parent as a **deferred-finalization** entry (finalize when subtasks all `verified`/`canceled`) |
| `failed`, verification + `retryable`   | re-dispatch (a later tick)                                                                                         |
| `failed`, verification + not retryable | park the gate (stays blocked); surface to the operator; no re-dispatch                                             |
| `failed`, other                        | cleanup + drop; surface to the operator; no auto-re-dispatch                                                       |
| *(no artifact)* terminal work          | cleanup + drop (ticket at a terminal §2.3 role, or bare PR merged/closed)                                          |
| *(no artifact)* no live owner          | re-dispatch the same coordinator                                                                                   |
| *(no artifact)* live owner             | nothing this tick                                                                                                  |

Milestone-review agent (step 5): review recorded → clear it; no live owner →
re-dispatch; live owner → nothing.

## Dispatch priority (step 8)

`budget` = free ledger entries at the start of the step. While `budget > 0` and
work remains, pick the first of: (1) an injected **bare PR**; (2) a
**deferred-finalization** parent whose subtasks are all `verified`/`canceled`;
(3) the highest-ranked `<available>` ticket (`target-kind` `pr`/`verification`).
`human-only` is never here (step 6). Dispatch reserves no slot; the unit acquires
its own. Injected items rank ahead of lower-ranked tickets but never preempt work
in flight.

## Logging (§2.3)

```
<timestamp> <kind> ticket=<url> pr=<url> ticket-role=<role> pr-state=<state> | <message>
```

`<timestamp>` RFC 3339 + offset, second precision. `<kind>` =
`TRANSITION`|`WAIT`|`RESUME`|`BLOCK`|`INFO`|`ERROR` (message required for all but
`INFO`). `ticket=`/`pr=` full URLs, `-` if absent.

| kind     | orchestrator use                                             |
| -------- | ------------------------------------------------------------ |
| `INFO`   | dispatch, slot fill, cleanup, reassignment, idle heartbeats  |
| `WAIT`   | entering a human-blocked wait (name venue + awaited outcome) |
| `RESUME` | a human-blocked ticket resolved                              |
| `ERROR`  | producer/tracker failures; a graph `<cycle>` anomaly         |

The orchestrator writes no ticket state itself — coordinators own all §2.3
transitions and state-change comments. It emits `WAIT`/`RESUME` and the human-alert
comment only for parks it is tracking.
