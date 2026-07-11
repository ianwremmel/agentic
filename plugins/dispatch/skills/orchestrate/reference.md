# orchestrate — reference

Lookups for [`SKILL.md`](./SKILL.md).

## Actors

- **Coordinator** — a [`work-ticket`](../work-ticket/SKILL.md) instance; owns one
  work item (a ticket's PR(s), a no-PR verification, or one injected PR).
- **Delivery worker** — a `deliver` instance inside a coordinator, one per PR.
  Not dispatched by you, but draws from your ledger.
- **Milestone reviewer** — a [`review-milestone`](../review-milestone/SKILL.md)
  instance; one per ready-for-review milestone.
- **Producer** — [`build-graph`](../build-graph/SKILL.md); your only *read* path
  to the tracker. Your only writes are the park transition and the human alert.

## Run directory

```
<run-dir>/
  graph.json        durable normalized graph + cursor   (build-graph owns the contents)
  document.json     last derived document               (read-only to you)
  active.json       { units: {<key>: {state, …}}, injected: [<ticket-id>] }
  ledger/slot-N/    one dir per held compute entry: owner + heartbeat
  locks/…           ticket-, PR-, or milestone-keyed liveness
  units/…           outcome.json, written by the unit as its final action
  inbox/*.json      injected work, drained each tick
```

Keys are encoded into path names — ask `unit dir <key>` for the path, never
build it from the key.

`scripts/dispatch-state <group> <command>`:

| command                                     | use                                                        |
| ------------------------------------------- | ---------------------------------------------------------- |
| `init`                                      | create the run dir (idempotent)                            |
| `slot acquire\|release\|heartbeat <owner>`  | compute entries; `acquire` exits 1 when the ledger is full |
| `slot free` / `slot reap`                   | free-entry count / reclaim entries with a stale heartbeat  |
| `lock acquire <key> <agent> <kind>`         | claim a unit; exits 1 if already locked                    |
| `lock live <key>` / `lock sweep`            | is the owner alive / clear stale locks                     |
| `active put <key> <json>` / `rm` / `keys`   | the active set; every key here is excluded from `available` |
| `active inject\|uninject\|injected <id>`    | ticket ids ranked to the top of the frontier               |
| `inbox drain`                               | print injected items and consume them                      |
| `unit dir\|outcome\|cleanup <key>`          | a unit's path / its outcome / remove its artifacts and lock |

Active-set `state`: `dispatched` (the only one reconciled for liveness),
`pending` (an injected PR awaiting dispatch), `deferred` (a `decomposed` parent),
`failed`, `human-blocked`. Every state keeps the key out of `available`, which is
what stops a failed or deferred ticket from being re-dispatched on a loop.

A slot `<owner>` must be unique per concurrently-computing agent (e.g.
`deliver:<repo>#<pr>`) — a coordinator running two builds holds two entries.
Staleness is `DISPATCH_STALE_SECS` (default 900 s); ledger size is
`DISPATCH_MAX_PARALLEL` (from `max_parallel`).

## Dispatch

Each unit holds a heartbeated lock and writes `units/<key>/outcome.json` as its
final action.

| unit                | key                  | inputs                                                               |
| ------------------- | -------------------- | -------------------------------------------------------------------- |
| coordinator, ticket | `<ticket_id>`        | `ticket_id`, `ticket_url`, `target_kind`, branch hint, identity/mode |
| coordinator, PR     | `<repo>#<pr_number>` | `repo`, `pr_number`, `pr_url`, `branch`, identity/mode               |
| milestone reviewer  | `milestone:<id>`     | milestone id + project                                               |

Hints are non-authoritative.

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

Dropping an entry re-admits its ticket to `available`, so only drop a unit whose
work is genuinely finished. Cleanup is the artifacts, the lock, any mirrored
"working" label, and any worktree the unit left behind. Never force-release a
live agent's ledger entry — the stale-heartbeat reaper takes those.

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

Drop one JSON file per item into `inbox/`:

```json
{ "kind": "ticket", "id": "DEV-42" }
{ "kind": "pr", "repo": "owner/name", "pr_number": 17, "pr_url": "https://…", "branch": "…" }
```

An injected ticket's dependency ancestors come in with it on the next fetch. Its
top-of-frontier rank lives in `active injected` until the work reaches a terminal
outcome — a tick that drains an injection while the ledger is full must not lose
it.
