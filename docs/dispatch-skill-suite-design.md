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
- It does not interpret natural-language comments substantively.
- It does not pick verification methods.
- It does not run milestone reviews.

All of those are dispatched to agent tasks.

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

## Persistence and state directory

### State directory layout

```
~/.dispatch/
  dispatcher.pid               # PID of the running daemon
  dispatcher.log               # daemon stdout/stderr
  dispatcher.last-tick         # epoch-seconds of last main-loop iteration
  queue/
    NNNN-<work-item>.txt       # one file per queued work item; numbered for FIFO
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
    held                       # newline-separated process-IDs currently holding a slot
  locks/
    <object-id>.lock           # short-held atomic locks for state mutations (flock)
```

### Daemon liveness

The dispatcher's PID file (`~/.dispatch/dispatcher.pid`) and the
mtime of `~/.dispatch/dispatcher.last-tick` jointly determine
whether the daemon is alive. Slash commands check both: if the
PID is gone or the last-tick is older than `2 ×
tick-interval-seconds` (default 2 minutes), the daemon is
presumed dead and the slash command respawns it.

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

### Single dispatcher per host

Only one dispatcher runs per host (per user). The PID file
serves as the lock. Two parallel sessions on the same host
share the same dispatcher; the cross-session conflict from the
prior design (two long-lived in-session orchestrators racing)
does not exist here.

If multiple hosts are involved (the user has dev environments
on multiple machines), each host has its own dispatcher, and
tracker assignment is the cross-host source of truth (a ticket
assigned to the agent identity on tracker is "claimed" globally
even if no local claim exists). On startup, each dispatcher
inspects the tracker for tickets / projects assigned to the
agent identity and adopts any that lack a local claim.

## The dispatcher daemon

### Lifecycle

**Startup** (triggered by a slash command's `ensure-daemon-running`):

1. Acquire `~/.dispatch/locks/dispatcher.lock`.
2. Check `dispatcher.pid` — if a live PID is already running
   the dispatcher, exit (idempotent).
3. Otherwise, fork into the background (`nohup` /
   `setsid` / equivalent) and write the new PID.
4. The dispatcher process initializes:
   - Read all of `~/.dispatch/projects/`, `tickets/`, `prs/`
     to seed in-memory state.
   - Inspect tracker(s) for objects assigned to the agent
     identity; auto-adopt any not already claimed locally.
   - Start main loop.

**Main loop** (runs every `tick-interval-seconds`, default 60):

1. Update `dispatcher.last-tick`.
2. **Drain queue** — process every file in `queue/`:
   - Each file is one of `project: <name>`, `ticket: <id>`,
     `pr: <url>`, `shutdown`, `status: <reply-fifo>`.
   - For project/ticket: claim and add to in-memory tracking.
   - For pr: register the PR (link to ticket if applicable,
     record session-id from the user-session origin).
   - For shutdown / status: handle directly.
   - Delete the queue file after processing.
3. **Reap completed agent tasks** — for each PID in
   `slots/held`, check if the process exited. If yes:
   - Read its exit code and any task-output file.
   - Update relevant state (`task-running`, last-progress).
   - Free the slot.
4. **Per-project polls** — for each claimed project, poll the
   tracker (changed-since filter) for ticket-set changes,
   update the actionable pool, evaluate dispatch.
5. **Per-ticket polls** — for each claimed ticket, poll the
   tracker for ticket-state changes (cancellation,
   reassignment, new blockers, actionable threads on the
   ticket).
6. **Per-PR polls** — for each claimed PR, fetch state per
   `pr-status-protocol.md`. Detect events (CI rollup change,
   new actionable thread, merge, close, conflict).
7. **Watchdog** — for each running agent task with elapsed time
   >= per-task timeout, kill the child, log `ERROR`, mark task
   timed-out, retry once or escalate.
8. **Dispatch** — for each free slot AND each event needing
   action, dispatch an agent task (FIFO across event types,
   with resume-from-task-queue priority — see below).
9. **Idle-shutdown check** — if no claimed work AND no
   in-flight tasks AND `dispatcher.last-tick` minus
   `last-active-time` > `idle-shutdown-seconds` (default 30
   min), shut down gracefully.

**Shutdown:**

1. Stop accepting new queue items (atomically rename `queue/`
   to `queue.shutdown/` so slash commands respawn a new daemon
   for any subsequent work).
2. Wait for in-flight agent tasks to complete (bounded; kill
   after grace period).
3. Persist final state to `~/.dispatch/`.
4. Remove `dispatcher.pid`.
5. Exit.

### Active-slot semaphore

The dispatcher maintains a single host-wide active-slot
counter, default 3 (configurable via `slots/cap`). Held slots
are tracked by child PID in `slots/held`.

Lifecycle:

- Dispatch an agent task → fork `claude` as a child, record
  PID in `slots/held`, decrement available count.
- Agent task exits (success, error, killed, timeout) → reap on
  next tick, remove PID from `slots/held`, increment available
  count.
- Resume-from-task-queue priority: if both a "fresh dispatch"
  and a "resume from waiting state" task are eligible for the
  same free slot, the resume wins (better to finish in-flight
  work than start new work).

The cap is host-wide; multiple parallel projects share it.

### Per-task timeouts (replaces the old watchdog)

Each task type has a default timeout. When elapsed time >=
timeout for a running task:

| Task               | Default timeout | On exceed                                                                  |
| ------------------ | --------------- | -------------------------------------------------------------------------- |
| `implement-step`   | 1 hour          | Kill child, mark task timed-out. First timeout: re-dispatch once. Second timeout: post `ERROR` comment on PR, leave for human.                  |
| `respond-thread`   | 30 min          | Same retry / escalate pattern.                                              |
| `verify-ticket`    | 1 hour          | Same pattern; on second failure, transition ticket to `awaiting-external` per protocol §"Verification failure." |
| `review-milestone` | 1 hour          | Kill, mark timed-out, post `ERROR` on milestone artifact, leave for human. |

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
| PR P review approved AND CI green                                  | Transition parent ticket to `finished` (scripted, no LLM)           | n/a (scripted)     |
| PR P merged                                                        | Transition parent ticket to `delivered` (scripted)                  | n/a (scripted)     |
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

The dispatcher's logic is mostly a state machine over these
events. The vast majority of transitions don't involve an LLM.

### Cancellation-intent detection

When a PR closes without merge, the dispatcher inspects the
close comment (or last human comment immediately preceding
close). Detection is regex-first:

- Cancel intent: case-insensitive matches on `cancel`, `won.?t do`,
  `abandon`, `dropping this`, `not pursuing`, `wontfix`.
- Otherwise: ambiguous → default to `available` (re-attempt is
  the conservative path).

For genuinely ambiguous comments where the regex can't decide,
the dispatcher MAY dispatch a single short `respond-thread`
task with a "classify cancellation intent" prompt, taking the
LLM result as the decision. This is an opt-in fallback, not
the default — keeping the regex-first rule reduces LLM cost
on the common case.

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
   the milestone artifact and may file follow-up tickets.
4. After the task exits, the dispatcher checks milestone state
   again. If newly-filed tickets put the milestone back into
   structurally-incomplete, normal dispatch resumes. Otherwise,
   advance to the next milestone.

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

```bash
# /dispatch:pr — pseudocode (rare; auto-activation usually preferred)
ensure-daemon-running.sh
queue-add.sh "pr: $(git rev-parse --abbrev-ref HEAD)"
echo "Queued: pr on current branch"
```

```bash
# /dispatch:status — pseudocode
ensure-daemon-running.sh  # in case nothing's running
FIFO=$(mktemp -u)
mkfifo "$FIFO"
queue-add.sh "status: $FIFO"
cat "$FIFO"
rm -f "$FIFO"
```

```bash
# /dispatch:shutdown — pseudocode
queue-add.sh "shutdown"
echo "Shutdown queued"
```

The `ensure-daemon-running.sh` helper is idempotent: it checks
the PID file + last-tick mtime, and only forks the dispatcher
if it's not alive.

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

| Failure                  | Detection                                                  | Recovery                                                                          |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Daemon process killed    | PID file references nonexistent process; or last-tick is stale | Next slash-command invocation respawns the daemon; state is reloaded from `~/.dispatch/`. |
| Host restart             | All processes dead; state dir intact                       | First slash command after restart respawns daemon, which re-adopts all claims by inspecting tracker assignments. |

In both cases, in-flight agent tasks (children of the dead
daemon) become orphan processes. They MAY continue running and
posting to PRs / tickets — that's fine; their writes follow
the protocol. Their PIDs are cleared from `slots/held` on
respawn (no live process matches), freeing the slots.

If an orphan agent's PID is later reused by an unrelated
process, the dispatcher's reap logic checks the process's
start-time and command-line to avoid false reaping.

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

When the dispatcher computes effective-blocking and finds a
cycle, it transitions the affected ticket to
`awaiting-external` (per protocol §"Dependencies"), posts a
comment naming the cycle path, and skips the ticket on
subsequent polls.

### Verification failure

First failure → re-dispatch `implement-step` with
`fix-verification` variant. If that succeeds, retry verify.
Second consecutive verification failure → transition ticket to
`awaiting-external` per protocol §"Verification failure," post
a summary comment.

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

| Command file          | Invocation                                  | What it does                                             |
| --------------------- | ------------------------------------------- | -------------------------------------------------------- |
| `commands/project.md` | `/dispatch:project <name>`                  | `ensure-daemon-running` + `queue-add "project: <name>"`  |
| `commands/ticket.md`  | `/dispatch:ticket <id-or-url>`              | `ensure-daemon-running` + `queue-add "ticket: <id>"`     |
| `commands/pr.md`      | `/dispatch:pr`                              | `ensure-daemon-running` + `queue-add "pr: <branch>"`     |
| `commands/status.md`  | `/dispatch:status`                          | Show daemon state via FIFO                               |
| `commands/shutdown.md`| `/dispatch:shutdown`                        | Queue shutdown                                           |

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

The dispatcher reloads the config on every tick, so overrides
take effect quickly without a daemon restart.

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
