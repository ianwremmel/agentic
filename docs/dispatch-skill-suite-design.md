# Dispatch Skill Suite

This document is the design for the `dispatch` plugin: a
script-driven dispatcher daemon plus a small set of focused
short-lived agent tasks that together deliver tracked
engineering work end-to-end. The system consumes the three
protocols already in this repo
(`agent-communication-protocol.md`,
`pr-status-protocol.md`,
`ticket-workflow-protocol.md`) and adds the orchestration,
worktree, persistence, and PR-lifecycle behavior the protocols
deliberately leave out.

This is a design document, not a protocol specification. It
describes how the system is organized, what each piece does, and
how they coordinate. Where it overlaps with the protocols, the
protocols are authoritative.

## Why this exists

The protocols define vocabulary and on-the-wire rules but say
nothing about the behavior that moves work through them. This
plugin fills that gap.

The architecture splits work along an LLM / no-LLM boundary:

- **The dispatcher daemon** — a long-running script (no LLM)
  responsible for polling, state management, claim tracking,
  ticket selection, milestone advance, slot management, and
  watchdog. None of this needs LLM judgment, and running it in
  an LLM context is expensive, slow, and error-prone.
- **Short-lived agent tasks** — Claude Code sessions invoked by
  the dispatcher for the operations that genuinely require LLM
  judgment: writing code, reading and responding to comment
  threads, content-specific verification, and milestone
  reviews. Each task runs to completion and exits.

The single user-facing skill, `dispatch:pr`, auto-activates when
the agent in a user session is about to make code changes in a
PR-driven repo. It captures intent (plan, motivation,
verification conditions) and registers the work with the
dispatcher; from that point on, the dispatcher orchestrates the
PR lifecycle through dispatched agent tasks.

## Scope

The design covers:

- the dispatcher daemon — lifecycle, main loop, event-to-action
  mapping, slot management, watchdog;
- agent tasks — `implement-step`, `respond-thread`,
  `verify-ticket`, `review-milestone` — and the skills that
  back them;
- the `dispatch:pr` skill — auto-activation in a user session
  for setup and hand-off;
- the persistent state at `~/.dispatch/`, including session-id
  tracking for resume;
- slash commands as thin queue-write shims;
- failure modes — daemon crash, agent timeout, tracker outage,
  branch divergence, cycle detection, verification failure;
- plugin layout, config layers, CLI vs MCP preference, and the
  manifest changes.

Out of scope:

- the self-improvement loop — covered by a separate design;
- per-tracker mapping implementation — handled inside the
  scripts as helpers; this design specifies contracts;
- exotic CI providers beyond GitHub Actions and Buildkite — the
  dispatcher reads native CI status; teams using other
  providers publish overrides through the configuration layers.

## Architecture overview

### Two layers

```
┌───────────────────────────────────────────────────────────────┐
│ Slash commands (thin shims)                                   │
│  /dispatch:project  /dispatch:ticket  /dispatch:pr            │
│  /dispatch:status   /dispatch:shutdown                        │
│   │                                                           │
│   ▼ ensure-daemon-running, queue-add, return                  │
│                                                               │
│ ┌──────────────────────────────────────────────────────┐      │
│ │ Dispatcher daemon (no LLM)                           │      │
│ │  - main loop: drain queue, poll, dispatch, reap      │      │
│ │  - state in ~/.dispatch/                             │      │
│ │  - ticket selection / ranking                        │      │
│ │  - claim management                                  │      │
│ │  - slot semaphore                                    │      │
│ │  - watchdog (per-agent timeouts)                     │      │
│ │  - event-to-action mapping                           │      │
│ └─────┬────────────────────────────────────────────────┘      │
│       │                                                       │
│       │ claude --resume <session-id> -p <task-prompt>         │
│       │   (or fresh session if resume fails)                  │
│       ▼                                                       │
│ ┌──────────────────────────────────────────────────────┐      │
│ │ Short-lived agent tasks (LLM)                        │      │
│ │  - implement-step (writes code, commits, exits)      │      │
│ │  - respond-thread (replies to PR / ticket comment)   │      │
│ │  - verify-ticket (validates against aims)            │      │
│ │  - review-milestone (aggregates outcomes, files      │      │
│ │    follow-ups)                                       │      │
│ └──────────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────────┘

User session → dispatch:pr skill (auto-activates)
   │
   ▼ captures plan / motivation / verification conditions,
     calls scripts to set up worktree + draft PR,
     registers with dispatcher,
     exits.
```

The user-facing entry point — `dispatch:pr` — is the only place
where an agent runs inside the user's interactive session. Once
it hands off, all subsequent LLM work happens in dispatcher-
spawned short-lived tasks.

### What each piece does

| Piece              | Responsibilities                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Slash commands     | Ensure daemon is running; append a work item to the queue; return immediately.                                    |
| Dispatcher         | Poll trackers / PRs; detect events; dispatch agent tasks; manage state; enforce the active-slot cap and watchdog. |
| `dispatch:pr` skill | In user session: capture intent, set up worktree + draft PR, register with dispatcher, exit.                     |
| Agent tasks        | Each does one focused thing (write code for one plan step, respond to one thread, verify one ticket, review one milestone) and exits. |

### What the dispatcher does NOT do

- It does not write code.
- It does not interpret natural-language comments substantively
  (read-side judgment about whether to act on a comment, what
  to reply, etc.). The cancellation-intent regex is the one
  exception, and it has an opt-in LLM fallback for ambiguous
  cases (see "Cancellation-intent detection" below).
- It does not pick verification methods.
- It does not run milestone reviews.

All of those are dispatched to agent tasks.

The dispatcher MAY invoke a **bounded cheap-model summarizer**
when polling PR / ticket state per `pr-status-protocol.md`
§"Summaries", because that protocol already specifies summaries
of non-actionable threads via `claude -p` with a cheap model.
This is a fixed-cost mechanical operation per non-actionable
thread, not an open-ended judgment call — it does not violate
the "no LLM" framing. The framing is about **judgment**, not
about ever-touching-a-model.

### What the agent tasks do NOT do

- They do not poll. The dispatcher polls; agent tasks are
  invoked when there's specific work to do.
- They do not manage state across invocations. The dispatcher
  records state; agent tasks read it from `~/.dispatch/` and the
  task spec.
- They do not run watchdogs or heartbeats. They run to
  completion or are killed by the dispatcher's per-task timeout.

### Communication restriction

The protocol's communication-restriction rule (`ticket-workflow-
protocol.md` §"Communication restriction") applies to every
dispatched agent task: each task runs against a tracked work
item and is therefore "assigned" from the moment it is
dispatched. Tasks MUST NOT solicit session input; they post to
the appropriate venue (PR or ticket) per the protocol's routing
rule.

The `dispatch:pr` skill running in a user session enters the
"assigned" state per protocol §8 the moment it opens the draft
PR. Pre-PR scoping conversation in the session is allowed;
post-PR conversation moves to the PR.

### All dispatch-authored writes go through the protocol writer

Every body-bearing comment authored by the dispatch plugin —
whether produced by the dispatcher daemon (timeout nudges,
escalation `ERROR` comments, state-change echoes,
cross-host-conflict notes, milestone-review confirmations) or
by a dispatched agent task — MUST be emitted via the same
writer used by LLM tasks. That writer enforces, per
`agent-communication-protocol.md` §"Wire format":

- the machine marker (`<!-- agent-reply:<agent-id> -->` or
  platform equivalent), with the dispatch plugin's stable
  `agent-id` from `~/.dispatch/agent-id`, AND
- the Mode A / Mode B visible marker as appropriate.

A dispatcher-authored comment without the machine marker would
be misclassified as human input by the next poll's
thread-actionability filter, causing infinite-loop
re-evaluation. There are no exceptions; even a one-line `ERROR`
nudge passes through the writer.

## Persistence and state directory

### State directory layout

```
~/.dispatch/
  agent-id                     # stable agent identifier; persists across sessions / restarts / reboots
  host-id                      # stable host identifier (per-machine; per-user)
  dispatcher.pid               # OS pid of the running daemon (diagnostic only — see "Daemon liveness" below)
  dispatcher.lock              # held via flock for the daemon's lifetime (the authoritative lifetime lock)
  dispatcher.log               # daemon stdout/stderr
  dispatcher.last-tick         # epoch-seconds of last main-loop iteration
  queue/
    incoming/                  # writers create files here via temp+rename for atomicity
      NNNN-<work-item>.txt     # one file per queued work item; numbered for FIFO
    in-progress/               # daemon atomically moves files here while processing
    processed/                 # processed items archived briefly for audit
    dead-letter/               # malformed or repeatedly-failing items
  projects/
    <tracker>/<project-id>/
      claim                    # epoch-seconds when claimed; empty when unclaimed
      mode                     # subagent | in-process (mode is per-project)
      milestone-state          # current milestone advance pointer
      pool-cache.json          # cached actionable-ticket pool with updatedAt timestamps
  tickets/
    <tracker>/<ticket-id>/
      claim                    # epoch-seconds when claimed
      worktree                 # absolute path to the worktree
      branch                   # branch name
      pr                       # PR URL once created
      session-id               # claude session-id for resume
      session-history          # newline-separated prior session-ids (audit)
      task-running             # task-type if a child agent is currently dispatched
      task-started             # epoch-seconds when task-running was dispatched
      abort                    # written to signal cleanup
  prs/
    <repo-slug>/<pr-number>/
      claim                    # epoch-seconds when claimed
      ticket-id                # parent ticket id, if any
      session-id               # claude session-id for resume
      task-running             # task-type if a child agent is currently dispatched
      task-started             # epoch-seconds when task-running was dispatched
      last-poll                # epoch-seconds of last PR poll
  slots/
    cap                        # active-slot capacity (default 3)
    leases/
      <lease-id>.lease         # JSON: {task-id, object-id, pid, pid-start-ns, dispatched-at}
    lock                       # held via flock during atomic slot acquire / release
  locks/
    <object-id>.lock           # short-held atomic locks for state mutations (flock)
```

### Operational logging integration

`ticket-workflow-protocol.md` §"Operational logging" requires
log entries on the "session transcript." The daemon is not a
Claude session, so the design clarifies what fills that role:

- **Daemon's session transcript** — `~/.dispatch/dispatcher.log`.
  Every protocol log line emitted by the daemon (`HEARTBEAT`,
  `TRANSITION`, `BLOCK`, `INFO`, `ERROR`, `WAIT`, `RESUME`)
  lands here, formatted per protocol §9.
- **Dispatched task's session transcript** — the claude session
  output (whatever Claude Code records for that session).
  Tasks emit protocol log lines to their own session output
  per the protocol's normal rules.
- **Correlation** — every dispatched task receives a
  `DISPATCH_TASK_ID` env var (UUID). The daemon's log line for
  the dispatch event includes this task id; the task's own
  log lines include it via the standard fields. Tail-then-grep
  by task id reconstructs the cross-process timeline.

The dispatcher's heartbeats (every 5 minutes per protocol §9)
land in `dispatcher.log`; users tail that file to watch the
daemon's activity.

### Daemon liveness

`~/.dispatch/dispatcher.lock`, held via `flock` for the daemon's
entire lifetime, is the authoritative lifetime lock. The PID file
(`dispatcher.pid`) and `dispatcher.last-tick` are diagnostic.

Slash commands implement `ensure-daemon-running` as: try to
acquire `dispatcher.lock` with `flock --nonblock`; if it fails,
the daemon is alive (someone else holds the lock); if it
succeeds, the daemon is dead — the slash command spawns a new
daemon (which immediately re-acquires the lock from its child
process) and the spawning shell drops its temporary lock.

A long tick (slow `gh` call, hung MCP) does NOT make the
dispatcher look dead — the lock is held continuously across
ticks. The PID is recorded for `top` / `htop` visibility and
includes `pid-start-ns` (procfs `/proc/<pid>/stat` field 22) so
PID reuse is detectable.

### Agent identity

The dispatcher writes a stable `agent-id` to `~/.dispatch/agent-id`
on first startup (default value: `dispatch-<host-id>-<random>`,
user-overridable via config). This identifier is distinct from
`session-id`:

- **`agent-id`** is the stable identifier embedded in every
  machine marker (`<!-- agent-reply:<agent-id> -->`) per
  `agent-communication-protocol.md` §"Machine marker." Persists
  across sessions, dispatcher restarts, and host reboots.
  Identifies the dispatch plugin's writer to other agents and
  to PR-status / thread-actionability filtering.
- **`session-id`** is the claude session UUID for resume.
  Per-object. Rotation rules:
  - On `verified` / `canceled`: the session is closed and the
    session-id is moved to `session-history` for audit. A new
    invocation against the same object would start fresh.
  - On `retry-fresh` (second consecutive failure on a task):
    the current session-id is rotated; the next attempt uses a
    new session.
  - Otherwise: reused across all dispatched tasks for the same
    object so context accumulates.

All comment writes — by the dispatcher itself OR by dispatched
agent tasks — MUST carry the same `agent-id` so other agents
and tools can identify "this was written by the dispatch plugin"
regardless of which session-id wrote it. The dispatcher passes
`agent-id` to every dispatched task as an env var
(`DISPATCH_AGENT_ID`).

`host-id` is a separate stable identifier (per machine,
persists across runs); used for cross-host lease coordination
below.

### Session-id tracking

Each ticket and each PR records the claude session-id used by
the most recent agent task on that object. When the dispatcher
needs to invoke another task on the same object, it tries
`claude --resume <session-id>` first; on failure (cache evicted,
session corrupted, etc.) it falls back to a fresh session
seeded with full context from the state dir and the tracker.

The history of session-ids is kept in `session-history` for
audit. Practical implication: the agent working a single ticket
across many tasks (implement step 1, implement step 2, respond
to comment, verify) reuses the same session-id throughout, so
its context grows naturally rather than re-loading on every
task.

### Caching

Two cache layers, separate from the persistent state:

| Layer        | Location                                          | Lifetime                                     | Purpose                                                                    |
| ------------ | ------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| PR cache     | `/tmp/dispatch/<repo-slug>/<pr-number>/`          | Until PR closes / merges                     | Per `pr-status-protocol.md`. Threads, annotations, summaries.              |
| Ticket cache | `/tmp/dispatch/tickets/<tracker>/<ticket-id>/`    | Until ticket reaches `verified` / `canceled` | Parallel layout. Threads, comments, dependency snapshot, history slice.    |

Both caches live in `/tmp/` (ephemeral) — rebuildable from the
tracker on demand and not expected to survive a host restart.
The persistent state in `~/.dispatch/` is the only permanent
dispatch state.

### Cache namespace

The `<skill>` placeholder in `pr-status-protocol.md` §"Cache
layout" is filled with `dispatch` for every dispatch sub-skill
(`dispatch:pr`, `dispatch:respond`, `dispatch:verify`,
`dispatch:review-milestone`). They share the namespace because
they coordinate through the dispatcher: object claims are
exclusive (only one task at a time runs against a given
ticket / PR), so two dispatch sub-skills never write the same
cache file simultaneously.

### Single dispatcher per host

Only one dispatcher runs per host (per user). The
`dispatcher.lock` flock serves as the lifetime lock. Two
parallel sessions on the same host share the same dispatcher;
the cross-session conflict from the prior design (two long-lived
in-session orchestrators racing) does not exist here.

### Cross-host coordination

If multiple hosts are involved (the user has dev environments
on several machines), tracker assignment alone is NOT a
sufficient lease — two hosts can both see a ticket assigned to
the shared agent identity, both claim it locally, and produce
competing worktrees and branches. The design requires a
**tracker-side exclusive lease** in addition to assignment.

Per claimed object, the dispatcher writes a lease marker on the
tracker:

| Tracker | Mechanism                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------- |
| Linear  | A custom field (`Dispatched by`) on the issue / project, with value `<host-id>:<expires-at-epoch>`.  |
| GitHub  | A label of the form `dispatched-by-<host-id>:<expires-at-epoch>` on the issue / PR.                  |
| Asana   | A tag (or custom field) of the same form.                                                            |

`<expires-at-epoch>` is renewed every tick to `now +
cross-host-lease-ttl-seconds` (default: 1800 seconds = 30
minutes; configurable). The TTL is deliberately MUCH longer
than `2 × tick-interval-seconds` because a single tick can
legitimately stretch on slow tracker / MCP / CI calls. Setting
the lease TTL to twice the tick interval would let another
host steal work during any long poll. The TTL must comfortably
exceed worst-case poll + retry-backoff + per-task-timeout
latency to avoid live-work theft.

In addition to the per-tick refresh in the main loop, the
dispatcher MAY renew leases more frequently from a separate
thread / timer (every 60 seconds regardless of main-loop
cadence) for hosts that anticipate long ticks. This is an
optional optimization; the main-loop renewal is the baseline.

Other hosts inspecting the object see the lease and skip if
not yet expired. Expired leases are replaced atomically using
compare-and-swap if the tracker supports it (Linear and GitHub
do via `If-Match`-style ETags); for trackers that don't, the
small read-modify-write race window is acceptable since two
hosts whose ticks coincide both see the expired lease and the
loser's lease write fails (or both succeed and one host
detects the conflict on the next tick and yields).

Lease released (label / field cleared) when the object reaches
a terminal state (`verified` / `canceled`) or the dispatcher
exits gracefully. Stale leases on host crash linger until the
expiry; that's the bound on adoption latency for a crashed
host's work.

A dispatcher startup, before acquiring local claims, MUST query
each candidate object's lease state and skip any with a fresh
non-self lease.

## The dispatcher daemon

### Lifecycle

**Startup** (triggered by a slash command's `ensure-daemon-running`):

1. Acquire `~/.dispatch/dispatcher.lock` via `flock --nonblock`.
   If acquisition fails, another dispatcher is alive — exit
   (idempotent).
2. Fork into the background (`nohup` / `setsid` / equivalent),
   passing the held lock file descriptor so the daemon retains
   it across the fork.
3. Write `dispatcher.pid` (`{pid, pid-start-ns}` for PID-reuse
   detection); write `agent-id` and `host-id` if not already
   set; touch `dispatcher.last-tick`.
4. Initialize:
   - Read all of `~/.dispatch/projects/`, `tickets/`, `prs/`
     to seed in-memory state.
   - Inspect tracker(s) for objects assigned to the agent
     identity that lack a fresh non-self lease (per "Cross-host
     coordination"); auto-adopt those that pass the lease
     check.
   - Reconcile `slots/leases/`: per the lease lifecycle in
     "Active-slot semaphore," delete `state: "reserved"`
     leases unconditionally and verify `state: "active"` leases
     against the live process table.
   - **Reclaim `queue/in-progress/`**: atomically move every
     file from `queue/in-progress/` back to `queue/incoming/`
     so the next main-loop drain re-processes them. Each file
     carries an `attempts` counter (in its sibling `.attempts`
     file); files with `attempts >= 2` go to `queue/dead-letter/`
     instead, with a reason of "exceeded retries on startup."
   - Start main loop.

**Main loop** (runs every `tick-interval-seconds`, default 60):

1. Update `dispatcher.last-tick`.
2. **Drain queue** — atomically process items in
   `queue/incoming/`:
   - For each file in `queue/incoming/` (sorted by name for
     FIFO order), atomically rename it into
     `queue/in-progress/`.
   - Validate the item against the queue grammar (see "Queue
     protocol" below). Malformed → move to `queue/dead-letter/`
     with a reason file.
   - Process the item:
     - `project: <name>` / `ticket: <id-or-url>` /
       `pr: <pr-url>` — acquire the cross-host lease, then
       claim locally; add to in-memory tracking.
     - `shutdown` — set the shutdown flag (handled at end of
       tick).
     - `status: <response-file>` — write the daemon's status
       summary to the named file and `fsync`.
   - On success, move the file to `queue/processed/` (kept
     briefly for audit; aged out after 24 h).
   - On unexpected error, leave the file in `queue/in-progress/`
     for retry on the next tick; if it fails twice, move to
     `dead-letter/`.
3. **Reap completed agent tasks** — for each lease in
   `slots/leases/`, check whether the recorded PID has exited
   (matching `pid-start-ns`). For exits:
   - Read the task's exit code and output file.
   - **Reconcile partial completion** — re-read the affected
     external state (PR body, ticket role, comment thread)
     before declaring success / retry / escalate. Tasks are
     idempotent; the dispatcher trusts external state, not
     just the exit code.
   - Update local state (`task-running`, last-progress).
   - Atomically delete the lease file (releases the slot).
4. **Per-project polls** — for each claimed project, poll the
   tracker (changed-since filter) for ticket-set changes,
   update the actionable pool. Renew the project's cross-host
   lease.
5. **Per-ticket polls** — for each claimed ticket, poll the
   tracker for ticket-state changes (cancellation,
   reassignment, new blockers, actionable threads on the
   ticket). Renew the ticket's lease.
6. **Per-PR polls** — for each claimed PR, fetch state per
   `pr-status-protocol.md`. Detect events (CI rollup change,
   new actionable thread, merge, close, conflict). Renew the
   PR's lease.
7. **Watchdog** — for each in-flight task lease with elapsed
   time >= per-task timeout, kill the child, log `ERROR`, mark
   task timed-out, retry once (per "Retry semantics" below) or
   escalate.
8. **Re-validate before dispatch** — apply changes from steps
   4–6 to the in-memory event set, dropping any actions that
   are no longer eligible (ticket was canceled, blocker was
   added, claim was lost to a competing host's lease). This
   step prevents stale-event dispatch.
9. **Dispatch** — for each free slot AND each remaining
   eligible event, dispatch an agent task. Resume-from-`WAIT`
   takes priority over fresh dispatch.
10. **Idle-shutdown check** — if no claimed work AND no
    in-flight tasks AND `dispatcher.last-tick` minus
    `last-active-time` > `idle-shutdown-seconds` (default
    30 min), shut down gracefully.

**Shutdown:**

1. Stop accepting new queue items: atomically rename
   `queue/incoming/` to `queue/incoming.draining/` so slash
   commands write to a freshly-created `incoming/` and respawn
   a new daemon for those items.
2. Wait for in-flight agent tasks to complete (bounded; kill
   after grace period).
3. Release all cross-host leases.
4. Persist final state to `~/.dispatch/`.
5. Drop the flock; remove `dispatcher.pid`.
6. Exit.

### Active-slot semaphore

The dispatcher maintains a single host-wide active-slot
capacity, default 3 (configurable via the `active-slot-cap`
config). Held slots are represented by **lease files** in
`~/.dispatch/slots/leases/`. Lease lifecycle is two-phase to
handle the fact that the child PID is unknown until after
`fork()`.

A complete lease file has this JSON shape:

```json
{
  "lease-id": "<uuid>",
  "task-id": "<task-id>",
  "task-type": "implement-step | respond-thread | verify-ticket | review-milestone",
  "object-id": "<tracker>:<id>",
  "state": "reserved | active",
  "pid": 12345,
  "pid-start-ns": 12345678901234567,
  "reserved-at": 1700000000,
  "dispatched-at": 1700000005
}
```

Acquire is **two-phase**:

1. **Phase 1 — reserve.** Under `flock(slots/lock)`, count
   `*.lease` files in any state; if `< cap`, write a new lease
   via temp+rename with `{state: "reserved", pid: null,
   pid-start-ns: null, reserved-at: <now>}`. Release
   `slots/lock`. The slot is now reserved against
   oversubscription but not yet bound to a process.
2. **Phase 2 — populate.** `fork()` the child; in the parent,
   re-write the lease file in place via temp+rename with
   `{state: "active", pid: <child-pid>, pid-start-ns:
   <start-ns>, dispatched-at: <now>}`. The flock is NOT
   re-acquired here; the file is owned by this dispatcher and
   no other writer touches it.

Failure handling:

- **Reservation written but `fork()` fails** — the dispatcher
  deletes the lease file immediately (no leak; slot returns
  to the pool).
- **Reservation written, fork succeeds, lease repopulation
  fails (disk full, etc.)** — the dispatcher kills the just-
  forked child (it has not yet started doing work), then
  deletes the lease.
- **Daemon crash between reserve and populate** — orphan
  recovery on next startup deletes all `state: "reserved"`
  leases unconditionally (no PID was ever bound).

Release:

- **Normal** — on reap, the dispatcher deletes the lease file
  under `flock(slots/lock)`.
- **Orphan recovery** — at startup, every `state: "active"`
  lease's `pid` + `pid-start-ns` is verified against the live
  process table; mismatches indicate orphaned leases (daemon
  crashed mid-task) and are deleted. `state: "reserved"`
  leases are always orphans (see above).

Resume-from-`WAIT` priority — when a slot frees, the
dispatcher first checks the resume-queue for parked tasks
needing a slot back; if any, the oldest resume wins. New
dispatches only proceed when no resumes are pending.

The cap is host-wide; multiple parallel projects share it.

### Queue protocol

The queue is the dispatcher's control plane and MUST be
durable.

**Enqueue.** Slash commands write to
`~/.dispatch/queue/incoming/` via temp-file-plus-rename:

```
1. Pick file name: NNNN-<short-id>.txt where NNNN is
   monotonically-increasing (zero-padded epoch-millis is fine).
2. Write the body to ~/.dispatch/queue/incoming/.tmp.<short-id>.
3. fsync the file.
4. atomic rename to ~/.dispatch/queue/incoming/NNNN-<short-id>.txt.
```

**Grammar.** Each queue item is a single line:

| Form                            | Semantics                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `project: <name>`               | Claim and orchestrate the project.                                                         |
| `ticket: <id-or-url>`           | Claim and dispatch the ticket.                                                             |
| `pr: <pr-url>`                  | Register the PR (URL identifies repo + number); written by the `dispatch:pr` skill after the draft PR is opened. |
| `shutdown`                      | Begin graceful shutdown at end of tick.                                                    |
| `status: <response-file-path>`  | Write a status summary to the named file (path created by the slash command via mktemp).   |

Items not matching the grammar go to `queue/dead-letter/` with a
sibling `.reason` file.

**Duplicate detection.** Identical work items submitted within
30 seconds are deduplicated (same `object-id` and same intent
type). Useful when a slash command is re-invoked accidentally.

**Failure handling.**

- Permission errors / full disk → the slash command surfaces
  the error to the user immediately. The daemon doesn't see
  these.
- Daemon crash during processing → `queue/in-progress/` items
  are retried on next startup; items that fail twice in a row
  go to `queue/dead-letter/`.
- Shutdown received via the queue → set the flag at the END of
  the current tick so partially-processed work in earlier
  steps completes.

### Retry semantics

When a dispatched task exits abnormally (timeout, non-zero
exit, killed by watchdog), the dispatcher retries up to ONCE
per object-event pair. The two retry modes:

| Retry # | Mode                | Session                                  | Rationale                                                                                |
| ------- | ------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1       | `retry-resume`      | Resume the same `session-id`             | Most failures are transient (flaky test, intermittent CI). Resume keeps context.         |
| 2       | `retry-fresh`       | Start a fresh session (rotate session-id) | If retry-resume failed, the session may be stuck (corrupted context, planning loop). Fresh session avoids reproducing the same failure. |

After two consecutive failures, the dispatcher escalates per
the per-task-timeout table — typically a comment on the
affected PR / ticket and human attention.

`retry-resume` writes a "previous attempt failed" preamble into
the task prompt so the agent isn't blindly repeating itself.
`retry-fresh` does NOT include the prior session's outputs;
the fresh agent re-orients from scratch.

### Idempotency and reconciliation

Every dispatched task MUST be idempotent against repeated
invocation:

- `implement-step` is idempotent if applied to a fully-checked
  plan: it re-runs the same step (commit-or-no-commit-needed)
  and exits.
- `respond-thread` is idempotent because the thread is marked
  with a terminal reaction / token after the first successful
  reply; subsequent invocations detect the marker and exit.
- `verify-ticket` is idempotent because the verification
  artifact comment is identifiable; re-runs detect the
  existing artifact and exit (or replace it if newer).
- `review-milestone` is idempotent because milestone reviews
  are anchored on the milestone artifact; re-running is a
  no-op if the artifact is fresh.

On reap, the dispatcher reconciles task results against
authoritative external state (PR body, ticket role, comment
markers) before deciding success / retry. Partial-completion
patterns:

- Agent pushed commits but failed to update the PR body
  checklist → dispatcher detects the unchecked plan items and
  re-dispatches `implement-step`.
- Agent posted a reply but failed to add the terminal reaction
  → dispatcher detects the missing reaction and re-dispatches
  `respond-thread` (which detects its own prior reply, just
  adds the reaction, exits).
- Agent ran verification successfully but the script crashed
  before writing the local exit-success → dispatcher reads
  the verification artifact comment from the ticket and
  treats verification as completed.

The general rule: external state (tracker / git remote) is the
source of truth. Local exit codes are only used to decide
whether to wait for the next task or escalate immediately.

### Avoiding duplicate dispatch when an orphan task is alive

A daemon respawn (after crash) may inherit lease files
referencing dead PIDs (cleaned up at startup) AND active orphan
processes that the prior daemon spawned and never reaped. The
respawned daemon's reconciliation rules:

1. Lease files with mismatched `pid-start-ns` → orphan; delete
   lease, reclaim slot.
2. Lease files with matching live `pid` AND `pid-start-ns` →
   the orphan is still active; the new daemon adopts it
   (treats as live in-flight work, applies normal reaping).
3. Before dispatching a new task on an object, the dispatcher
   inspects recent activity on the object: if a commit was
   pushed in the last `2 × tick-interval-seconds` and there is
   no live lease for it, an orphan agent is presumed to still
   be working — defer dispatch one tick to give it time to
   exit cleanly.

### Per-task timeouts (replaces the old watchdog)

Each task type has a default timeout. When elapsed time >=
timeout for a running task:

| Task               | Default timeout | On exceed                                                                                                                                                       |
| ------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implement-step`   | 1 hour          | Kill child, mark task timed-out. Apply retry semantics (`retry-resume` then `retry-fresh`) per "Retry semantics" below. After two failures, post `ERROR` comment on PR. |
| `respond-thread`   | 30 min          | Same retry pattern.                                                                                                                                              |
| `verify-ticket`    | 1 hour          | Same retry pattern. After two failures, the dispatcher transitions the ticket to `awaiting-external` (a dispatch policy choice — see "Verification failure" below). |
| `review-milestone` | 1 hour          | Same retry pattern. After two failures, post `ERROR` on milestone artifact, leave for human.                                                                     |

Timeouts catch genuinely-stuck agents (looping, hung tools,
runaway implementations). The user does not need to monitor
agents — the dispatcher does.

### Event-to-action mapping

The dispatcher's central decision logic, per tick:

| Event                                                              | Action                                                              | Task type          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------ |
| Project P has a newly-actionable ticket T (and slot is free)       | Claim T, set ticket role to `in-progress`, dispatch                 | `implement-step`   |
| Ticket T's plan has unchecked steps after `implement-step` exit    | Dispatch next step (resume same session)                            | `implement-step`   |
| Plan fully checked off                                             | Run quality gates (`simplify` then Codex if available)              | `implement-step` (with task variant `quality-gate`) |
| PR P CI failed                                                     | Dispatch agent to diagnose and fix                                  | `implement-step` (variant `fix-ci`) |
| PR P new actionable thread                                         | Dispatch agent to address it                                        | `respond-thread`   |
| PR P meets ready-for-finished criteria (see "Finished detection" below) | Transition parent ticket to `finished`                          | n/a (scripted)     |
| PR P merged                                                        | If P was the last outstanding PR for the parent ticket per its PR-checklist, transition the ticket to `delivered` (scripted). Otherwise just check off P on the ticket's PR-checklist and continue working remaining PRs. | n/a (scripted)     |
| Ticket T `delivered`, deploy completed                             | Dispatch verification                                               | `verify-ticket`    |
| Verification succeeded                                             | Transition ticket to `verified`, run cleanup (scripted)             | n/a (scripted)     |
| Verification failed (first time)                                   | Transition ticket to `in-progress`, dispatch fix                    | `implement-step` (variant `fix-verification`) |
| Verification failed (twice consecutively)                          | Transition ticket to `awaiting-external`, post comment              | n/a (scripted)     |
| All tickets in milestone reach `verified` / `canceled`             | Dispatch milestone review                                           | `review-milestone` |
| Ticket canceled by human                                           | Cleanup: close draft PR if any, remove worktree, release claim      | n/a (scripted)     |
| Ticket reassigned to non-agent identity                            | Release claim, leave worktree, log INFO                             | n/a (scripted)     |
| New blocker added on ticket making it effectively-blocked          | Pause: don't dispatch new work for this ticket; comment on ticket   | n/a (scripted)     |
| PR closed without merge, comment indicates cancellation intent     | Transition parent ticket (if any) to `canceled`, cleanup            | n/a (scripted)     |
| PR closed without merge, no cancellation intent in close comment   | Transition parent ticket back to `available` for re-dispatch        | n/a (scripted)     |
| PR closed without merge, comment is ambiguous                      | Default to `available` (conservative)                               | n/a (scripted)     |
| Daemon detects stuck child (timeout exceeded)                      | Kill, retry once, escalate on second timeout                        | n/a (scripted)     |

The dispatcher's logic is a state machine, but the state
machine is defined by the **protocol**, not by the dispatcher.
`ticket-workflow-protocol.md` §"State transitions" enumerates
the legal role transitions; the event table above is the
mapping from observed external events to those transitions.
The dispatcher's job is to detect the event, apply the
protocol-specified transition, and dispatch the agent task (if
any) that the transition requires. The vast majority of these
transitions don't involve an LLM.

Implementation note: the state machine is per-object (per
project, per ticket, per PR). Each object's local state
(`role`, `claim`, `task-running`, `session-id`, lease) is
mutated under that object's `~/.dispatch/locks/<object-id>.lock`
to prevent concurrent ticks racing on the same object — though
since there's only one dispatcher per host, the locks mostly
serve to defend against the dispatcher and a slash command
mutating the same object simultaneously.

### Finished detection (Mode A vs Mode B)

The transition `in-review → finished` uses different signals
depending on the agent's authentication mode for the PR
(`agent-communication-protocol.md` §"Modes"):

- **Mode A (agent-credentialed PR — separate bot account).**
  Trigger: `<reviews>` element from `pr-status-protocol.md`
  shows a non-bot reviewer's latest review state is `approved`,
  AND CI rollup is `passing`, AND every review thread is
  non-actionable.
- **Mode B (human-credentialed PR — agent shares the user's
  account).** No formal `approved` review can be submitted by
  the human reviewer (platform forbids self-review when the PR
  author and reviewer are the same account).
  `agent-communication-protocol.md` §"Reading a review (Mode B,
  inverse)" prescribes that the agent must evaluate every
  human comment as either a question to answer, an instruction
  to act on, or already-resolved context to skip — there is NO
  protocol requirement that humans use terminal reactions /
  tokens. Waiting for a formal `approved` state in Mode B is a
  protocol violation, and waiting strictly for a terminal
  reaction would deadlock the workflow on a "looks good"
  comment that didn't carry a `+1`.

  The Mode B trigger is therefore: CI rollup is `passing`,
  AND every review thread is non-actionable, AND the human
  reviewer's most recent activity on the PR is **read as
  resolved-context-or-approval** rather than a question /
  instruction. Concretely:
  - Terminal reaction (`+1`, `rocket`) on a recent agent
    comment → finished.
  - Text-token (`Done.`, `Shipped.`) on a recent agent
    comment → finished.
  - A new top-level human comment whose body the
    `respond-thread` task (or its detection helper) classified
    as approval-shaped (e.g., "looks good", "ship it", "lgtm")
    → finished. Classification is via the same regex-first
    helper used for cancellation-intent (with similar regex:
    `lgtm`, `looks?\s*good`, `ship\s*it`, `approved`), with the
    same opt-in LLM fallback for ambiguous cases (config:
    `approval-intent-llm-fallback`).
  - A new human comment that the agent has already classified
    as a question or instruction → NOT finished; remains in
    review iteration.

Mode is determined per-PR by inspecting the PR author identity:
if the PR author is a known bot identity (per protocol §"Mode A"
detection), Mode A; else Mode B.

### Multi-PR tickets

`ticket-workflow-protocol.md` §"Multi-PR tickets" requires that
a ticket only transition to `delivered` once **all PRs needed
to satisfy its aims** are merged or deployed. Single-PR
tickets are the simple case; multi-PR tickets need the
dispatcher to track the PR set.

The ticket's PR-checklist lives on the parent ticket itself
(in the ticket body, distinct from each individual PR's plan
checklist), as a markdown checklist of expected PRs:

```
## PRs

- [ ] {short description of PR 1}
- [ ] {short description of PR 2}
- [ ] {short description of PR 3}
```

The ticket subagent (or `dispatch:pr` skill at registration
time) is responsible for filling the PR-checklist. The
dispatcher reads the PR-checklist on every ticket poll;
checking off entries when the corresponding PR merges. The
ticket transitions to `delivered` only when every PR-checklist
entry is checked off AND no unchecked entries remain.

If a single-PR ticket has no PR-checklist (no `## PRs`
section), the first merged PR triggers `delivered` directly —
the absence of the section signals "single PR is sufficient."

### Cancellation-intent detection

When a PR closes without merge, the dispatcher inspects the
close comment (or last human comment immediately preceding
close). Detection is regex-first:

- Cancel intent: case-insensitive matches on `cancel`, `won.?t do`,
  `abandon`, `dropping this`, `not pursuing`, `wontfix`.
- Otherwise: ambiguous → default to `available` (re-attempt is
  the conservative path).

The regex is **best-effort**: it will mis-classify genuinely
clever phrasings ("let's punt for now" reads as ambiguous; "no
need to ship this" reads as ambiguous). The conservative
default to `available` means false-cancellations are rare; the
common failure mode is treating an intentional cancellation as
"try again," which the next poll's human disposition (a
follow-up comment, a re-cancel) corrects.

For genuinely ambiguous comments where the regex can't decide,
the dispatcher MAY dispatch a single short `respond-thread`
task with a "classify cancellation intent" prompt, taking the
LLM result as the decision. This is an opt-in fallback
(`cancellation-intent-llm-fallback: true`), not the default —
keeping the regex-first rule reduces LLM cost on the common
case.

### Ticket selection and ranking

On every project poll:

1. **Refresh actionable pool** via changed-since filter (per
   protocol §"Dependencies" refresh efficiency rule). Maintain
   `pool-cache.json` to avoid full enumeration.
2. **Filter** to actionable: role `available`, unassigned or
   assigned-to-agent, not effectively blocked, in current
   milestone (if milestones exist) OR unconstrained (if not).
3. **Rank** by: earliest due date → highest priority → earliest
   `createdAt` → ticket-ID for determinism.
4. **Dispatch** top-ranked tickets up to the slot cap.

Resumes-from-waiting take priority over new dispatches.

### Milestone advance

Same logic as the prior design but executed by the dispatcher,
not an in-session agent:

1. After every project poll, check whether the current
   milestone is structurally complete (all tickets `verified`
   or `canceled`).
2. If complete AND no in-flight subagents on this milestone,
   dispatch a `review-milestone` task.
3. The `review-milestone` task produces an outcome comment on
   the milestone artifact AND a structured result file at
   `~/.dispatch/projects/<tracker>/<project-id>/milestone-review-result.json`
   with fields: `goal-met` (bool), `follow-up-tickets`
   (list of newly-filed ticket IDs), `advance-to` (next
   milestone identifier or `null` if no further milestones).
4. The dispatcher consumes this result transactionally on
   reap: it reads the result file before re-polling the
   milestone state. If `goal-met` is false OR
   `follow-up-tickets` is non-empty, the milestone is treated
   as structurally-incomplete (regardless of what a
   pre-result-arrival poll might have shown) and normal
   dispatch resumes. Otherwise the dispatcher advances the
   milestone-state pointer to `advance-to` atomically.
5. Reading the result file before applying the advancement
   prevents the race where a follow-up ticket filed by the
   review task hasn't shown up yet in a tracker poll, leading
   the dispatcher to advance prematurely.

### Tracker resolution

Same algorithm as before: repo context → available tooling →
disambiguation → error. Tooling preference is CLI > MCP (see
"Tooling requirements" below).

## Slash commands

Each slash command is a small markdown file that runs a bash
snippet. They do not invoke skills; they only enqueue work for
the dispatcher.

```bash
# /dispatch:project — pseudocode
NAME="$*"  # everything after /dispatch:project
ensure-daemon-running.sh
queue-add.sh "project: $NAME"
echo "Queued: project '$NAME'"
```

```bash
# /dispatch:ticket — pseudocode
ID_OR_URL="$1"
ensure-daemon-running.sh
queue-add.sh "ticket: $ID_OR_URL"
echo "Queued: ticket $ID_OR_URL"
```

```
# /dispatch:pr — special: NOT a thin queue-write shim
# This command activates the dispatch:pr skill in the current
# session (the explicit equivalent of the auto-activation path).
# The skill captures intent, sets up worktree + draft PR, and
# only then enqueues `pr: <pr-url>` for the dispatcher. The
# slash command does NOT directly enqueue work — there is no
# PR URL yet at slash-command time.
```

The other slash commands are thin queue-write shims because
their work items can be expressed without LLM judgment.
`/dispatch:pr` is an exception: capturing the plan, motivation,
and verification conditions from the conversation requires the
LLM, so the skill must run in-session before the dispatcher can
take ownership.

```bash
# /dispatch:status — pseudocode
# Uses a response file (not a FIFO) so a dead or hung daemon
# doesn't block the slash command indefinitely.
ensure-daemon-running.sh
RESPONSE=$(mktemp -t dispatch-status.XXXXXX)
queue-add.sh "status: $RESPONSE"
# Wait for daemon to write, with a timeout
deadline=$(($(date +%s) + 30))
while [ ! -s "$RESPONSE" ] && [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 0.5
done
if [ -s "$RESPONSE" ]; then
  cat "$RESPONSE"
else
  echo "Status timeout — daemon may be unresponsive."
fi
rm -f "$RESPONSE"
```

```bash
# /dispatch:shutdown — pseudocode
queue-add.sh "shutdown"
echo "Shutdown queued"
```

The `ensure-daemon-running.sh` helper is idempotent per the
"Daemon liveness" section above: it tries to acquire
`dispatcher.lock` via `flock --nonblock`. Failure means a
daemon is alive; success means it is not, and the helper forks
a new one (which inherits the held lock). The PID file is
diagnostic only.

## The `dispatch:pr` skill

The one user-facing skill. Auto-activates when an agent in a
user session is about to make code changes in a PR-driven repo.

### Activation

Triggered by:

- **Implicit (default)** — the agent in a user session
  recognizes that it's about to make code changes (any tool
  call that would modify files in the working directory) and
  the session is in a PR-driven repo. The skill is loaded.
- **Configurable behavior** — the user-overridable config flag
  `dispatch-pr-mode` controls the activation: `auto`
  (immediately apply the workflow; default), `ask` (offer to
  apply, defer otherwise), or `manual` (only on explicit
  `/dispatch:pr`).
- **Explicit slash command** — `/dispatch:pr` queues a setup
  request, treated identically to implicit activation.

PR-driven is the default repo assumption; repos opt out via a
marker in `CLAUDE.md` ("this repo does not use PRs"). Absence
of `.github/workflows/` or `.buildkite/` is NOT in itself an
opt-out.

### Behavior

The skill runs end-to-end as a short self-contained subroutine
in the user session:

1. **Capture intent.** From the user's prompt and conversation
   so far, the agent extracts:
   - A motivation paragraph (one paragraph, why this work
     exists).
   - An execution plan as a checklist of steps.
   - Verification conditions, if any are stated or strongly
     implied (e.g., "make sure login still works" → a
     verification item).
2. **Resolve parent ticket** if any. If the agent was told
   about a ticket, or the current branch already exists at
   `claude/<ticket-id>-...` matching a claim in
   `~/.dispatch/tickets/`, the parent ticket is established.
   Otherwise the work is **casual** (no parent ticket).
3. **Set up the workspace** by calling scripts:
   - Create worktree at the canonical path
     (`~/projects/worktrees/<repo>/<topic>-<rand>` for casual,
     or `~/projects/worktrees/<repo>/<ticket-id>-<slug>-<rand>`
     for parent-ticket).
   - Create branch `claude/<topic>-<rand>` (matches worktree
     dir name).
   - Make the empty scaffold commit
     (`git commit --allow-empty -m "chore: scaffold pr [skip ci]"`)
     — `[skip ci]` is recognized by GitHub Actions and
     Buildkite. The commit is dropped on rebase before the PR
     is marked ready for review (see `implement-step` task
     below).
   - Push the branch.
   - Open a draft PR with the body containing: ticket link
     (parent-ticket case), motivation, execution plan
     checklist, and verification section (casual case with
     conditions).
4. **Register with the dispatcher.** Write
   `~/.dispatch/prs/<repo-slug>/<pr-number>/` with the PR URL,
   parent-ticket-id, and the current claude session-id (so the
   dispatcher can resume this session for subsequent tasks).
   Append `pr: <pr-url>` to the dispatcher queue.
5. **Exit.** The skill is done. Subsequent code-writing for
   this PR happens through dispatcher-dispatched
   `implement-step` tasks.

The user is told what was set up and that the dispatcher will
take it from there. The user MAY close the session at any
point; the dispatcher continues on its own. The user MAY also
keep the session open and continue conversing — but the
dispatcher's dispatched tasks for this PR will run in
parallel, not in this session.

### What the skill does NOT do

- It does not run the implementation loop (that's
  `implement-step`).
- It does not poll for CI failures or comments (the dispatcher
  does).
- It does not handle review iteration or merge wait (the
  dispatcher does, dispatching `respond-thread` and watching
  state).
- It does not run verification (the dispatcher dispatches
  `verify-ticket`).

### Casual vs parent-ticket invocations

| Aspect                   | Casual (no ticket)                           | Parent-ticket                                |
| ------------------------ | -------------------------------------------- | -------------------------------------------- |
| Worktree path            | `<repo>/<topic>-<rand>`                      | `<repo>/<ticket-id>-<slug>-<rand>`           |
| Branch name              | `claude/<topic>-<rand>`                      | `claude/<ticket-id>-<slug>-<rand>`           |
| PR body ticket link      | None                                         | Linked to the parent ticket                  |
| State dir entry          | `prs/<repo-slug>/<pr-number>/` only          | Both `prs/<repo-slug>/<pr-number>/` AND `tickets/<tracker>/<ticket-id>/` |
| Verification             | Runs only if conditions captured at setup    | Always runs (per protocol §"Definition of Done") |
| Terminal state           | Casual conditions verified OR PR merged      | Ticket reaches `verified`                    |

## Agent tasks

The dispatcher invokes agent tasks via `claude --resume
<session-id> -p <task-prompt>` (with fallback to a fresh
session). Each task runs to completion and exits.

The four task types share one trait: each maps to a focused
skill with a clear input contract and output deliverable. The
prompts are plugin-internal; the skill files are the contract
the agent reads on activation.

### `implement-step` (skill: `dispatch:implement`)

**Input:** parent ticket id (or "casual"), branch name,
worktree path, plan checklist (current state), task variant
(`step` | `quality-gate` | `fix-ci` | `fix-verification`).

**Behavior by variant:**

- **`step`** — pick the next unchecked plan item, implement it
  (write code, commit, push), update the PR body to check it
  off (`gh pr edit --body ...`), exit. If new sub-tasks
  surface, append them as additional unchecked items. If an
  out-of-scope blocker surfaces, follow the protocol's
  decomposition rule (file blocking ticket, log `BLOCK`).
- **`quality-gate`** — invoked when the plan is fully checked
  off. Run `simplify` first (apply findings, commit, push).
  Then run Codex adversarial review if available (apply agreed
  findings, commit, push; otherwise log `INFO`). Once both
  gates are clean, drop the empty `[skip ci]` scaffold commit
  via interactive rebase, force-push, mark the PR ready for
  review (transition out of draft).
- **`fix-ci`** — fetch the failing check's logs, diagnose,
  apply fix, commit, push, exit.
- **`fix-verification`** — read the verification-failure
  comment posted by the dispatcher, apply the fix, commit,
  push, exit.

**Output:** committed changes (or no-op + comment if no fix is
appropriate). Exit code 0 on success, non-zero on
non-recoverable error.

### `respond-thread` (skill: `dispatch:respond`)

**Input:** PR URL or ticket URL, thread or comment ID, full
thread content (read from cache).

**Behavior:**

Read the thread per `agent-communication-protocol.md`
read-side rules. Decide: agree-and-act, agree-and-acknowledge,
or decline-with-rationale. Apply changes if any (commit, push).
Reply on the same thread with the appropriate terminal token
or reaction per protocol §"Terminal signals."

**Output:** comment posted on the thread; possibly a commit on
the branch if the thread requested code changes. Exit code 0
on success.

### `verify-ticket` (skill: `dispatch:verify`)

**Input:** ticket URL, merge commit SHA, deploy state.

**Behavior:**

1. Inspect the diff between the merge commit and its parent.
2. Inspect the ticket's stated aims and any explicit
   verification method documented on the ticket.
3. Pick a verification method (CI rollup of default branch,
   exercise the changed endpoint against production, fetch
   rendered docs, etc.).
4. Run the verification. May call shell tools, dispatch
   sub-subagents for rote work (see "Long-lived agents
   dispatching their own subagents" below).
5. Post the verification artifact comment per protocol
   §"Definition of Done": three required fields (what was
   verified, how, what was not verified).
6. Return success / failure to the dispatcher. The dispatcher
   transitions the ticket; the agent does not.

**Output:** verification artifact comment + return code.

### `review-milestone` (skill: `dispatch:review-milestone`)

**Input:** project URL, milestone identifier.

**Behavior:**

1. Fetch the milestone's tickets and their verification
   artifacts.
2. Aggregate outcomes: what was delivered, what was canceled,
   what's notable.
3. Decide: was the milestone goal achieved? If not, file
   follow-up tickets in the same milestone (which will revert
   it to structurally-incomplete).
4. Post the outcome comment on the milestone's review artifact
   (Linear project update, GitHub Milestone closure comment,
   Asana milestone-task comment).

**Output:** outcome comment + 0+ follow-up tickets filed.

### Sub-subagents inside an agent task

A long task (verification, review-milestone, large
implement-step) MAY dispatch its own short-lived subagents via
the standard Claude Code subagent mechanism for rote work
(running test suites, summarizing large diffs, generating
commit messages). These are scoped to the parent task, not
registered with the dispatcher's state, and exit with the
parent.

## Failure modes and recovery

### Daemon crash

| Failure                  | Detection                                                          | Recovery                                                                          |
| ------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Daemon process killed    | `dispatcher.lock` becomes acquirable via `flock --nonblock`        | Next slash-command invocation respawns the daemon; state is reloaded from `~/.dispatch/`. |
| Host restart             | All processes dead; state dir intact                               | First slash command after restart respawns daemon, which re-adopts all claims subject to cross-host lease checks. |

In both cases, in-flight agent tasks (children of the dead
daemon) become orphan processes. They MAY continue running and
posting to PRs / tickets — that's fine; their writes follow
the protocol. Their lease files in `~/.dispatch/slots/leases/`
are reconciled on the new daemon's startup per the "Active-slot
semaphore" rules: leases whose recorded `pid` + `pid-start-ns`
no longer match a live process are deleted, freeing the slot.
Leases that DO match a live process are adopted (the orphan
agent is treated as live in-flight work, applying normal
reaping).

### Worktree adoption

When the dispatcher adopts a stale-claim ticket on respawn or
host restart, it takes over the worktree **unconditionally**:

- Uncommitted changes are presumed to be unfinished work from
  the prior session and absorbed by the next dispatched
  `implement-step` task naturally.
- The dispatcher does NOT auto-discard, auto-stash, or
  escalate to human on dirty state.
- Branch state is reconciled by `git fetch + rebase` if
  divergence is detected and clearly the agent's own commits.

This is a deliberate trade. Dirty state could in theory be
human edits, partial generated output, conflict markers, or
synced state from another host — and absorbing those into the
next commit could ship garbage. The mitigation is the user's
own pre-merge review (the human merges the PR; if the diff
looks wrong, they don't merge). The alternative (escalate on
dirty state) traded reliable recovery for fragility, and the
user explicitly chose the unconditional-adoption path.

### Agent task timeout

Per the table in "Per-task timeouts" above. First timeout
re-dispatches once (resumes the same session-id, so context is
preserved). Second timeout escalates by posting a comment on
the affected PR / ticket and leaving for human attention.

### Tracker or MCP unavailable

When a poll fails (CLI errors, MCP unavailable, network
disconnect, auth expired):

1. Retry with exponential backoff up to 3 attempts (1s, 5s,
   15s).
2. If still failing, the dispatcher logs `ERROR` and skips the
   affected object on this tick. Continues normally for other
   objects.
3. After 1 hour of consecutive failures on the same tracker,
   the dispatcher posts an `ERROR` comment on every claimed
   object on that tracker (deduplicated by machine marker per
   `agent-communication-protocol.md`) and continues retrying.

The dispatcher does NOT shut down on tracker failure; it
remains alive and retries. Local state mutations affecting an
unavailable tracker are deferred (the dispatcher does not
write through stale state).

### Branch divergence on push

When an agent task tries to push and the remote has commits
the local doesn't:

1. The agent fetches the remote branch.
2. If the remote commits are clearly the agent's own (matching
   author), it rebases local onto remote and pushes.
3. Otherwise, it logs `ERROR` and exits non-zero. The
   dispatcher receives the failure, posts an `ERROR` comment
   on the PR, and leaves for human. The dispatcher does NOT
   retry — divergence with non-agent commits is a state
   conflict that needs human resolution.

### Cycle detection

`ticket-workflow-protocol.md` §"Dependencies" §"Cycles"
prescribes that read-time cycle detection MUST surface the
cycle as an error. It does NOT prescribe a role transition.

The dispatcher therefore:

1. Emits `ERROR` log entry with the cycle path.
2. Posts a comment on each affected ticket (using the protocol
   writer per "All dispatch-authored writes go through the
   protocol writer") naming the cycle path and tagging a human.
3. Skips the affected tickets on subsequent polls until the
   cycle is resolved (an edge is removed) or the ticket is
   canceled by a human.

The dispatcher does NOT transition tickets autonomously on
cycle detection — that is a state change the protocol does not
authorize for this case. The human can of course transition
the ticket themselves after seeing the posted comment.

### Verification failure

`ticket-workflow-protocol.md` §"Verification failure"
prescribes the corrective transition `verified → in-progress`
on a verification failure (i.e., a regression discovered after
the verification artifact was already posted), retaining the
artifact and adding a corrective comment.

This dispatch design adopts a stricter **dispatch policy** for
the case where verification fails BEFORE reaching `verified` —
the verify-ticket task fails outright (returns failure to the
dispatcher), so no `verified` transition was ever applied:

1. **First failure** — re-dispatch `implement-step` with the
   `fix-verification` variant; on success, re-dispatch
   `verify-ticket`.
2. **Second consecutive failure** — dispatcher policy: emit
   `ERROR` log, post a summary comment on the ticket, and
   transition the ticket to `awaiting-external` so a human can
   intervene. This is dispatch-policy, NOT
   protocol-prescribed; teams can override via configuration
   if they want a different escalation rule (deferred to
   implementation plan).

### Idle shutdown of an unwanted daemon

If the user wants to stop the dispatcher without waiting for
idle-shutdown, `/dispatch:shutdown` queues a graceful
shutdown. In-flight tasks are allowed to complete (bounded);
the daemon then exits.

If the user wants to abandon all in-flight work, they can kill
the dispatcher PID and remove `~/.dispatch/dispatcher.pid`. The
state dir's per-object directories remain; the next slash
command will respawn the daemon and re-adopt them.

## Plugin layout and tooling requirements

### Directory structure

```
plugins/dispatch/
  .claude-plugin/
    plugin.json
  skills/
    pr/SKILL.md                    # auto-activates on code-change intent
    implement/SKILL.md             # invoked by dispatcher for implement-step tasks
    respond/SKILL.md               # invoked for respond-thread tasks
    verify/SKILL.md                # invoked for verify-ticket tasks
    review-milestone/SKILL.md      # invoked for review-milestone tasks
  commands/
    project.md                     # /dispatch:project
    ticket.md                      # /dispatch:ticket
    pr.md                          # /dispatch:pr (rare)
    status.md                      # /dispatch:status
    shutdown.md                    # /dispatch:shutdown
  agents/
    (none)
  hooks/
    (none yet — possibly post-tool hook to ensure daemon running)
  scripts/
    dispatcher.sh                  # daemon entry point
    dispatcher-tick.sh             # one main-loop iteration (called by daemon)
    ensure-daemon-running.sh       # idempotent daemon start
    queue-add.sh                   # append to dispatcher queue
    setup-pr.sh                    # worktree + branch + scaffold + draft PR
    state/                         # state-dir helpers (atomic writes, locks, etc.)
    poll/
      tracker-linear.sh
      tracker-github.sh
      tracker-asana.sh
      pr-status.sh                 # wraps pr-status-protocol output
  config/
    defaults.yaml
```

### Script contracts

This design fully specifies the contracts for the scripts that
make up the dispatcher's safety story (queue, lock, lease,
state mutations). The non-safety scripts (poll wrappers,
setup-pr.sh) have their detailed argument grammar and output
shapes deferred to the implementation plan, but the safety
contracts below are normative.

#### `queue-add.sh` contract

| Aspect           | Contract                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input            | A single string body following the queue grammar (see "Queue protocol").                                                                                |
| Atomicity        | MUST write to `~/.dispatch/queue/incoming/.tmp.<short-id>`, `fsync`, then atomic rename to `~/.dispatch/queue/incoming/NNNN-<short-id>.txt`.            |
| Failure modes    | Returns non-zero on permission error / full disk / invalid grammar; the slash command surfaces the error to the user. Daemon never sees these.         |
| Idempotency      | NOT idempotent. Each invocation enqueues a new item. Caller-side dedup (slash command-level) is the duplicate-detection mechanism.                     |
| Side effects     | Creates exactly one file in `queue/incoming/`. No other state mutation.                                                                                 |

#### `ensure-daemon-running.sh` contract

| Aspect           | Contract                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input            | None.                                                                                                                                                   |
| Atomicity        | MUST acquire `~/.dispatch/dispatcher.lock` via `flock --nonblock`. Lock acquisition is the only synchronization needed; spawn-on-success is safe.       |
| Idempotency      | Idempotent — multiple concurrent invocations all succeed (one wins the lock and spawns the daemon, the rest see "lock held" and exit 0).                |
| Failure modes    | Returns non-zero only if the spawn itself fails (rare). If lock is held → no-op exit 0.                                                                 |
| Side effects     | Either no-op (if daemon alive) OR forks a daemon that holds `dispatcher.lock` for its lifetime.                                                         |

#### Lease lifecycle (under `flock(slots/lock)`)

| Operation                      | Atomicity guarantee                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 — reserve              | Hold `slots/lock`, count leases, write reserved lease via temp+rename, release `slots/lock`. The slot count is consistent under the lock.             |
| Phase 2 — populate post-fork   | NO lock; the dispatcher owns the lease file by `lease-id`. Re-write via temp+rename in the same directory.                                            |
| Release on reap                | Hold `slots/lock`, delete the lease file, release `slots/lock`.                                                                                        |
| Orphan cleanup at startup      | Hold `slots/lock`, iterate leases: delete `state: "reserved"` unconditionally; delete `state: "active"` if PID + pid-start-ns mismatch.               |

#### Per-object state mutation (under `flock(locks/<object-id>.lock)`)

State files in `~/.dispatch/projects/`, `tickets/`, `prs/` are
mutated through helpers that ALWAYS:

1. Hold the per-object `locks/<object-id>.lock`.
2. Read the current state file via `read-then-validate`.
3. Compute the new state (a function of current state + the
   triggering event).
4. Write via temp+rename.
5. Release the lock.

This prevents the dispatcher and a slash-command-driven
mutation from clobbering each other on the same object.

#### Deferred to implementation plan

Argument grammar, exit code conventions, and stdout / stderr
output formats for each script. Those are best decided
alongside the first implementation. The contracts above
specify the safety-critical behavior; the implementation plan
fills in the surface details.

### Skill files

Each `SKILL.md` is a focused task contract:

- `dispatch:pr` — user-session entry point (auto-activation).
  Captures intent, sets up workspace, registers with dispatcher,
  exits.
- `dispatch:implement` — implement a plan step / quality gate /
  CI fix / verification fix. Variant in the prompt selects
  behavior.
- `dispatch:respond` — read a thread, decide, reply.
- `dispatch:verify` — verify a ticket per its aims.
- `dispatch:review-milestone` — aggregate milestone outcomes.

Each skill references the protocols by link, not duplicating.

### Slash commands

| Command file          | Invocation                                  | What it does                                                                       |
| --------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `commands/project.md` | `/dispatch:project <name>`                  | `ensure-daemon-running` + `queue-add "project: <name>"`                            |
| `commands/ticket.md`  | `/dispatch:ticket <id-or-url>`              | `ensure-daemon-running` + `queue-add "ticket: <id>"`                               |
| `commands/pr.md`      | `/dispatch:pr`                              | Activates the `dispatch:pr` skill in-session; the skill enqueues `pr: <pr-url>` after opening the draft PR. |
| `commands/status.md`  | `/dispatch:status`                          | Writes status to a temp response file with a 30s timeout (see "Slash commands" pseudocode). |
| `commands/shutdown.md`| `/dispatch:shutdown`                        | Queue shutdown                                                                     |

Plugin-namespaced. No collision risk with other plugins.

### Configuration

Three layers, deepest-wins:

1. **Plugin defaults** —
   `plugins/dispatch/config/defaults.yaml`. Ships with
   thresholds, cadences, the active-slot cap, per-task
   timeouts, and per-tracker mapping defaults.
2. **User overrides** — `~/.dispatch/config.yaml`.
3. **Repo overrides** — `<repo-root>/.dispatch/config.yaml`
   (in-repo, version-controlled).

The dispatcher reloads the config on every tick. Reload
semantics vary per setting; the table below classifies each:

| Reload class       | Behavior                                                                                  | Settings in this class                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `immediate`        | Takes effect on the very next tick, no special handling.                                  | `tick-interval-seconds`, `idle-shutdown-seconds`, `wait-timeout-*`, `dispatch-pr-mode`, `pr-driven-default`, `default-reviewer`, `cancellation-intent-llm-fallback`. |
| `next-task-only`   | Affects only newly-dispatched tasks. In-flight tasks honor the value at their dispatch time. | `task-timeout-*` (changing while a task is running would otherwise prematurely time it out), `active-slot-cap` (lowering does not preempt in-flight tasks; the new value applies once existing leases drain). |
| `restart-required` | Does NOT take effect until the dispatcher restarts. Logged as `INFO` if changed.          | `tracker-overrides` (mid-tick mapping changes would mis-classify in-flight objects), `agent-id`, `host-id`. |

Settings exposed:

| Setting                            | Default       | Where used                                                        |
| ---------------------------------- | ------------- | ----------------------------------------------------------------- |
| `active-slot-cap`                  | 3             | Active-slot semaphore.                                            |
| `tick-interval-seconds`            | 60            | Dispatcher main-loop cadence.                                     |
| `idle-shutdown-seconds`            | 1800 (30 min) | Daemon idle shutdown threshold.                                   |
| `dispatch-pr-mode`                 | `auto`        | `auto` / `ask` / `manual` for `dispatch:pr` skill activation.     |
| `task-timeout-implement-seconds`   | 3600 (1 hr)   | `implement-step` per-task timeout.                                |
| `task-timeout-respond-seconds`     | 1800 (30 min) | `respond-thread` per-task timeout.                                |
| `task-timeout-verify-seconds`      | 3600 (1 hr)   | `verify-ticket` per-task timeout.                                 |
| `task-timeout-milestone-seconds`   | 3600 (1 hr)   | `review-milestone` per-task timeout.                              |
| `wait-timeout-ci-seconds`          | 3600 (1 hr)   | Dispatcher waits this long on a `pending` CI before posting nudge.|
| `wait-timeout-review-seconds`      | 86400 (24 hr) | Initial human review response timeout.                            |
| `wait-timeout-merge-seconds`       | 86400 (24 hr) | Human merge timeout after approval.                               |
| `tracker-overrides`                | (empty)       | Per-tracker mapping overrides.                                    |
| `pr-driven-default`                | true          | Whether unmarked repos are assumed PR-driven.                     |
| `default-reviewer`                 | (none)        | Human reviewer to request when no other signal exists.            |
| `cancellation-intent-llm-fallback` | false         | Whether to dispatch an LLM task to disambiguate ambiguous PR-close comments. |

### Tooling requirements

CLI > MCP. Required tooling:

| Operation                | Preferred CLI                  | MCP fallback        | Notes                                                                  |
| ------------------------ | ------------------------------ | ------------------- | ---------------------------------------------------------------------- |
| GitHub PR / Issue ops    | `gh`                           | `github` (optional) | `gh` covers everything; MCP not required.                              |
| Linear                   | (none first-party)             | `linear` (required) | No mature first-party CLI.                                             |
| Asana                    | (none first-party)             | `asana` (required)  | Same.                                                                  |
| Buildkite                | `bk` if installed              | `buildkite`         | Either works; CLI preferred when present.                              |
| Codex adversarial review | codex CLI via the codex plugin | n/a                 | Optional; quality-gate skips if absent.                                |
| Worktree, branch, push   | `git`                          | n/a                 | Standard.                                                              |
| JSON parsing in scripts  | `jq`                           | n/a                 | Common dev-container default.                                          |
| File locking             | `flock`                        | n/a                 | Used by `~/.dispatch/locks/`.                                          |

The dispatcher inspects which tracker integrations are
available at startup and on tracker resolution.

### Mode B credential handoff (Copilot review request)

In Mode B (agent shares account with human), requesting a
Copilot review on github.com requires an alternative credential
the human must grant. The plugin defers the mechanism but
reserves these slots in the config schema:

- `copilot-credential-source` — one of `env-var`, `keychain`,
  `not-configured`.
- `copilot-credential-name` — env var name or keychain entry
  name.

When `not-configured`, the github.com review path skips the
Copilot step and proceeds to direct human review.

### Hooks

None planned for v1. Possible future:

- A `post-edit` hook to make `dispatch:pr` activation more
  deterministic than current heuristic detection.

### Plugin manifest

`plugins/dispatch/.claude-plugin/plugin.json`: bump `version`
from `0.1.0` to `0.2.0`. No other manifest changes.

### Marketplace entry

`/.claude-plugin/marketplace.json` already lists `dispatch`;
no change needed.
