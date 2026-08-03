# Deterministic orchestration

How dispatch drives a project after the graph is built: the CLI schedules every
unit of work and pushes work orders over the channel; agents execute them and
report back through commands. This is the slice that retires the legacy `cli/`
tree and the agent-driven orchestration skills.

The division of labor is the ingest slice's, extended to scheduling: the CLI
decides — ranking, gating, claiming, capacity — and the session executes. The
orchestrate session never reads the graph to choose work; it relays each work
order to a worker agent.

## Scope

Paths are relative to `plugins/dispatch/` unless they start with `docs/`.

In: the derived read-model over the v2 schema, session registration and the
probe/ack handshake, work-order emission (tickets, prompt PRs, milestone
reviews, parking, failure alerts, completion), the worker-facing command
surface (outcomes, slots, reviews, PR injection), the worker agent files, the
orchestrate dispatch loop, and the removal of the legacy tree and skills.

Out: PR/CI watching (`ci_finished` and friends, the `pr-status` port into the
CLI) — workers drive their PRs through the `land` skill, which owns PR-state
reads via `bin/pr-status`. That phase layers cleanly on top of this one.

## Read-model

`src/lib/graph/` ports the legacy derivation (`cli/lib/graph/queries.mts`) onto
the v2 schema: one CTE pipeline every query shares, so blocking, ranking,
gating, and admission always agree.

The v2 differences that reshape the SQL:

- **Membership is an edge.** `ticket → milestone` means the ticket is a member
  (the milestone waits on it). `milestone → milestone` is sequencing. Every
  other edge is plain blocking. Members are found by joining edges, not a
  `milestone_id` column.
- **The gate is derived from sequencing.** A ticket T that is a member of
  milestone M is gated while any milestone in M's sequencing-ancestor closure
  is not open. A milestone is **open** when it has members, every member is
  resolved (`verified`/`canceled`), no member carries an unresolved dependency,
  and its review is recorded and still valid (covers exactly the current member
  set, and no member moved after it was recorded — the `review`/`review_member`
  tables, finally written by `review record` below). A direct
  `milestone → ticket` edge gates the same way: the milestone participates in
  blocking as resolved-iff-open.
- **Claim liveness is session liveness.** A claim is live while its session's
  heartbeat is fresh. Workers do not heartbeat; the server heartbeats its
  session row on its tick, and a dead server's claims go stale together.
- **PRs are nodes, and every PR item is dispatchable.** A bare `pr` row
  (origin `prompt` or `adopted`) is prompt work; a ticket-attached one is a
  unit of implementation its ticket-worker registered, blocking its ticket
  until delivered. Both are handed to pr-workers by the scheduler.

Classification keeps the legacy vocabulary — `verified`, `canceled`,
`in-flight`, `dormant`, `blocked`, `human-blocked`, `available`, in that
precedence — driven by `status`, `requires_human`/`target_kind`, live claims,
and the derived blocking/gating. Parked statuses (`paused`,
`awaiting-external`) classify human-blocked. The dispatch queue re-admits
invested work as passes exactly as the legacy queue did: `resume` (stale claim,
no outcome), `verify` (delivered ticket), `finalize` (decomposed parent whose
subtasks resolved), `retry` (retryable failure), ahead of the ranked available
frontier; ranking is injected first, then priority, then descendant fan-out,
then id.

Placeholder nodes (`unknown`) block their dependents, and anomalies surface
what writes could not prevent: dangling placeholder endpoints (including those
resolved `missing` by ingest), milestones named but never declared, mutually
blocking project pairs, and cycles as a safety net.

Two read commands expose it: `dispatch status` (per-project counts, milestone
gates, anomalies, and a `terminal` verdict) and `dispatch queue` (what the
scheduler would hand out next, with passes). Operators and tests read these;
the server consumes the library directly.

## Sessions and the handshake

`dispatch mcp` registers a session row at startup — a minted registry id, plus
host, pid, and the `CLAUDE_CODE_SESSION_ID` from its own environment — then
heartbeats it on the tick and retires it on exit. Schema v3 adds the
`claude_session_id` and `acked_at` columns (the DB is a rebuildable cache; no
migration).

The server pushes a `probe` event carrying its registry id until an
acknowledgement lands, on a capped backoff. `dispatch mcp ack --server <id>`
records the acknowledgement and stamps the acking process's session id onto the
row. `dispatch mcp status` reports `active` only when the caller's environment
session id matches a live acked row, and otherwise names the failure
(`no-session-id`, `no-server-for-session`, `ambiguous-session`,
`awaiting-ack`). The server emits fetch instructions freely but **no work
order before the ack** — a work order claims a ticket, which a refused session
would never work while the live server keeps the claim fresh.

## Scheduling and work orders

The server gains a timer tick (a few seconds; also run after every tool call,
where the drain already runs). Each tick, in order:

1. Heartbeat its session; sweep sessions whose heartbeat is stale, cascading
   their claims and slots away.
2. Reconcile refreshes (the ingest drain, unchanged).
3. If acked: fill capacity. Free capacity = `--max-parallel` (a `dispatch mcp`
   option, default 3) minus held slots. For each queue entry up to that count,
   claim the node for this session under an immediate transaction and emit one
   work order. A node already claimed by any live session is skipped — two
   servers on one DB cannot double-dispatch.
4. Emit the condition orders: `perform_milestone_review` for each milestone
   with members, none open-or-blocked, and no valid review (claimed
   milestone-keyed, same as tickets); `park_human_blocked` for each
   human-blocked ticket not yet parked; `alert_failure` for each non-retryable
   failure not yet surfaced; `project_complete` once per project whose counts
   go terminal.

Work orders are durable where they must be: a ticket dispatch is its claim (a
crashed session's claims go stale and the queue re-serves the node as
`resume`), a review dispatch is the milestone's claim, and parking/alerting/
completion are re-derived from graph state each tick with an emitted marker so
they fire once per episode.

The event catalog gains the work-order kinds:

| kind                       | meta                   | body asks the session to                          |
| -------------------------- | ---------------------- | ------------------------------------------------- |
| `dispatch_ticket`          | `project`, `ticket`    | run a ticket-worker for the ticket (claim held)   |
| `dispatch_pr`              | `pr`, `ticket?`        | run a pr-worker for the PR item                   |
| `perform_milestone_review` | `project`, `milestone` | run a milestone-reviewer (claim held)             |
| `park_human_blocked`       | `project`, `ticket`    | park the ticket and post the human handoff        |
| `alert_failure`            | `project`, `ticket`    | alert the operator on the ticket                  |
| `project_complete`         | `project`              | announce completion and stop                      |

`dispatch_pr` is new: the spec's catalog folded injected PRs into
`dispatch_ticket`, but a PR item is implementation work, not coordination —
a distinct kind keeps both prompts honest.

## Worker commands

- `dispatch outcome set --id <node> --outcome <kind> [--retryable] [--detail]`
  — the worker's final report; releases the claim and the actor's slot in the
  same transaction. `dispatch outcome rm --id` requeues surfaced work.
- `dispatch slot acquire --actor <id>` / `dispatch slot release --actor <id>` /
  `dispatch slot status` — the compute-capacity ledger. Workers acquire before
  writing code, building, or testing, and release for any wait; `acquire`
  refuses (with a wait hint) when the ledger is full.
- `dispatch review record --milestone <id>` — records the review with a member
  snapshot, opening the gate. Follow-up tickets filed by the review re-enter
  through ingest and re-block the gate by invalidating the snapshot.
- `dispatch pr set` (`--id`, and optionally `--ticket`, `--repo`,
  `--pr-number`, `--url`, `--branch`, `--title`, `--origin`, `--injected`,
  `--priority`) / `dispatch pr rm --id` — records PR nodes: runtime injection
  of bare PRs, and workers recording the PRs a ticket produced.

## Agents and skills

Worker behavior moves from skills to **agent files** under
`plugins/dispatch/agents/`, dispatched as background subagents by the
orchestrate session:

- `ticket-worker` — one ticket's **coordination**, never its implementation:
  it loads `tracker-adapter-<id>` for the brief and status transitions, then
  either decomposes into subtasks or registers the ticket's PR work as PR
  items (`pr set --ticket` plus a blocking edge per item) and reports
  `decomposed` — the scheduler dispatches each item to a pr-worker as compute
  frees up. When the children resolve it returns on the `finalize` pass to
  verify the aims against the landed code and close the ticket. Replaces
  `work-ticket`.
- `pr-worker` — one PR item's **implementation**, bare or ticket-backed:
  drives it with `land`, records the outcome. It never transitions a ticket —
  that stays with the ticket-worker. Replaces `deliver`.
- `milestone-reviewer` — one milestone review: verifies members against their
  aims and the landed code, files follow-ups through the tracker, records the
  review (or releases the claim with the gate closed). Replaces the
  `milestone-review` skill.

`land` stays a skill: it is the shared delivery engine the workers invoke, and
the standalone entry point it already is. `tracker-adapter-linear` stays and
drops its legacy-CLI cursor note (the cursor rides `refresh done`).

`orchestrate` keeps its ingest phase and gains the dispatch loop: after
`refresh_complete` it stays resident, answers `mcp ack` probes, relays each
work order to the matching agent, performs the tracker-write orders
(`park_human_blocked`, `alert_failure`) itself through the adapter, and stops
on `project_complete` or the operator. In the no-channel fallback it polls
`dispatch queue` and `dispatch status` on the same judgment.

## Teardown

With the above in place, in one final slice:

- delete `plugins/dispatch/cli/` and the `graph`/`wait` command families;
- collapse the `bin/dispatch` router to always run `src/main.mts`;
- delete the `work-ticket`, `deliver`, and `milestone-review` skills;
- update the plugin README and repo docs to the flat surface;
- bump the plugin minor version.

The spec is updated alongside: §2.6 reframed around the server-driven tick
(the orchestrator session becomes a relay, not a scheduler), §3.1.2's event
catalog gains the ingest and `dispatch_pr` kinds, and §3.2's command tables
replace `graph task --role` with the flat `ticket --status` surface.

## Errors

Per `lib/errors`: full slots and missing claims are `DataError`s whose hints
name the wait-and-retry; `mcp ack` for an unknown registry id and
`review record` for a milestone with open members are `DataError`s naming the
state that refused; every option failure is a `UsageError` listing the
vocabulary.

## Testing

One rule per test, the load-bearing ones:

- a ticket blocked by an unresolved ancestor never appears in the frontier; a
  canceled ancestor unblocks it;
- membership and sequencing edges gate members of a later milestone until the
  earlier milestone is open, and a recorded review stops counting when the
  member set changes or a member moves after it;
- a live claim excludes a node from the queue; the same claim under a stale
  session re-serves it as `resume`;
- delivered/decomposed/retryable-failed outcomes re-admit exactly their pass;
- the tick claims before it emits, and two sessions on one DB never emit for
  the same node;
- no work order is emitted before the ack; fetch instructions still are;
- `park_human_blocked`, `alert_failure`, and `project_complete` fire once per
  episode and re-fire on a new episode;
- `outcome set` releases the claim and slot atomically; `slot acquire` refuses
  at capacity;
- `review record` snapshots members and a follow-up member invalidates it;
- a bare PR is dispatched as `dispatch_pr` and a ticket-attached PR never is.
