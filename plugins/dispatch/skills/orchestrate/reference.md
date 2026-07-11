# orchestrate — reference

Lookups for [`SKILL.md`](./SKILL.md).

## Run directory

`dispatch-state` is on `PATH` and holds the run's state in SQLite, so concurrent
agents cannot lose each other's writes.

```
<run-dir>/
  state.db        slots, locks, units, injections
  graph.json      durable normalized graph + cursor  (project-graph owns it)
  document.xml    the derived document you read
  units/<n>/      outcome.xml, written by each unit as its final action
```

| command                                    | use                                                            |
| ------------------------------------------ | -------------------------------------------------------------- |
| `slot acquire\|release\|heartbeat <owner>` | compute entries; `acquire` exits 1 when the ledger is full     |
| `slot free` / `slot reap`                  | free-entry count / reclaim entries with a stale heartbeat      |
| `lock acquire <key> <agent> <kind>`        | claim a unit; exits 1 if already locked                        |
| `lock live <key>` / `lock sweep`           | is the owner alive / clear stale locks                         |
| `unit put <key> <state> [detail]`          | record a unit; every key here is excluded from `<available>`   |
| `unit keys` / `unit list`                  | the active set                                                 |
| `unit dir\|outcome\|cleanup <key>`         | a unit's path / its outcome / drop it, its lock, its artifacts |
| `inject add\|drop\|list <key>`             | ticket ids ranked to the top of the frontier                   |
| `inject queue <json>` / `inbox drain`      | queue ad-hoc work / take what is queued                        |

Unit `state`: `dispatched` (the only one reconciled for liveness), `pending` (an
injected PR awaiting dispatch), `deferred` (a `decomposed` parent), `failed`,
`human-blocked`. Each keeps the key out of `<available>`. An `inject add` alone
does **not** — that ticket is waiting to be dispatched, at the top of the
frontier.

A slot `<owner>` must be unique per concurrently-computing agent (e.g.
`deliver:<repo>#<pr>`) — a coordinator running two builds holds two entries.
Staleness is `DISPATCH_STALE_SECS` (default 900 s); ledger size is
`DISPATCH_MAX_PARALLEL` (from `max_parallel`). Ask `unit dir <key>` for a unit's
path; never build it from the key.

## Dispatch

Each unit runs as a background subagent with `DISPATCH_RUN_DIR` exported, holds a
heartbeated lock, and writes `outcome.xml` in its `unit dir` as its final action.

| unit                | key                  | inputs                                                               |
| ------------------- | -------------------- | -------------------------------------------------------------------- |
| coordinator, ticket | `<ticket_id>`        | `ticket_id`, `ticket_url`, `target_kind`, branch hint, identity/mode |
| coordinator, PR     | `<repo>#<pr_number>` | `repo`, `pr_number`, `pr_url`, `branch`, identity/mode               |
| milestone reviewer  | `milestone:<id>`     | milestone id + project                                               |

Hints are non-authoritative. Ticket *content* is never passed — the coordinator
fetches its own brief.

## Reconciling a coordinator

| outcome                               | action                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `verified` / `canceled`               | cleanup, drop (terminal)                                                               |
| `delivered`                           | cleanup, drop — a separate verification item takes the ticket to `verified`            |
| `human-blocked`                       | cleanup; keep the entry as `human-blocked`; the parked ticket is handled by step 6     |
| `decomposed`                          | cleanup; keep the entry as `deferred` — dispatch again once every subtask is `verified`/`canceled` |
| `failed`, verification, retryable     | cleanup; re-dispatch on a later tick                                                   |
| `failed`, verification, not retryable | keep the entry as `failed`; surface to the operator; the gate stays blocked            |
| `failed`, other                       | keep the entry as `failed`; surface to the operator; no auto-re-dispatch               |
| **no outcome**, work is terminal      | cleanup, drop (the ticket reached a terminal role, or the bare PR closed, out of band) |
| **no outcome**, no live lock          | re-dispatch the same coordinator                                                       |
| **no outcome**, live lock             | nothing this tick                                                                      |

Dropping an entry re-admits its ticket to `<available>`, so only drop a unit whose
work is genuinely finished. Cleanup is the artifacts, the lock, any mirrored
"working" label, and any worktree the unit left behind. Never force-release a live
agent's ledger entry — the stale-heartbeat reaper takes those.

## Human alerts

An alert is a comment on the routing venue: the machine marker
`<!-- agent-reply:<agent-id> -->` alone on the first line, and inside the body

```
<!-- agent-human-alert:<orchestrator-id> -->
```

Scan the venue for an unresolved alert bearing that sentinel before posting. An
alert resolves when a human replies with addressable content; then log `RESUME`
and let the next fetch return the ticket to the frontier.

## Injection

A human or another agent queues work for a running orchestrator:

```
dispatch-state inject queue '{"kind":"ticket","id":"DEV-42"}'
dispatch-state inject queue '{"kind":"pr","repo":"owner/name","pr_number":17,"pr_url":"…","branch":"…"}'
```

The next tick's `inbox drain` takes it (exactly once). An injected ticket's
dependency ancestors come in with it on the next fetch, and its top-of-frontier
rank persists — a tick that finds the ledger full must not lose the injection.
