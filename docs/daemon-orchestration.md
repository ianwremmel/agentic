# Daemon Orchestration

This document describes the design of the **dispatch daemon** — a
long-running operational driver that runs Claude Code (or another
agent runner) in response to external events, so an agent can
monitor work without a human keeping a terminal open. It is a
design doc, not a protocol: the existing protocol docs
(`agent-communication-protocol.md`, `pr-status-protocol.md`,
`ticket-workflow-protocol.md`, `do-work-protocol.md`) define what
an agent emits and observes; this doc defines the process that
wakes the agent up so it can do those things.

The existing protocols are deliberately silent on "the agent's
operational driver, event subscription, polling loop, etc." (see
`do-work-protocol.md` § Scope). This design fills exactly that gap.

## Why this exists

A single agent session is interactive: a human starts it, types
into it, and closes it. Real engineering work doesn't fit in one
session. CI takes minutes; reviewers take hours; tickets sit
between humans for days. The protocols require the agent to
monitor PRs and tickets across those gaps and react to new events
— but nothing in the protocols actually keeps a process alive
between events.

The daemon fills that role. It runs in the background on a
developer machine (or a long-lived sandbox), subscribes to the
event sources the protocols read from, and resumes the
appropriate agent session for each event with a prompt that tells
the session what just happened and which task to act on. The
session does its work according to the protocols, exits, and the
daemon goes back to waiting — preserving the session ID so the
next event can resume the same conversation rather than starting
cold.

## Scope

Covered:

- the daemon's process model (one daemon per machine, task state
  on disk, agent sessions resumed per event)
- event sources the daemon subscribes to and the orchestration
  strategy for each
- the prompt-template system (built-in defaults, repo override,
  home-dotdir override, XML- or Markdown-bodied) and the
  resolution order
- the spawn contract for agent sessions (runner abstraction,
  permission mode, working directory, env, stdio)
- session continuity across events, mutable follow-up coalescing,
  and crash recovery
- the binary distribution targets and install layout
- cross-references to the protocols this design serves

Not covered:

- the wire format of agent posts (see
  `agent-communication-protocol.md`)
- the PR-state vocabulary or actionability rules (see
  `pr-status-protocol.md`)
- the ticket lifecycle and operational logging (see
  `ticket-workflow-protocol.md`)
- the worktree/PR-open sequence and reviewer progression (see
  `do-work-protocol.md`)
- non-GitHub PR platforms and non-Buildkite CI providers (out of
  scope for the initial version; the daemon is structured to
  accept additional adapters later)

## Process model

### One daemon per machine

There is a single daemon process per machine. Multiple agent
sessions or repositories share it. Running two daemons on the
same machine is forbidden — the daemon takes an exclusive PID
lockfile on startup and refuses to start if another instance
holds it.

The daemon is not a system service. It is launched by the user
(typically through a `dispatch daemon start` command, a login
agent on macOS, or a user-level systemd unit on Linux) and runs
under the invoking user's account, with that user's credentials
for GitHub, Linear, and any other platform the protocols touch.

### Tasks, not sessions, are the unit of persistent state

The persistent unit is a **task** — one PR or one ticket the
daemon is monitoring. Tasks live in the daemon's state directory
between events. An agent session is logically long-lived (one
session per task, reused across events) but physically transient:
the runner process exits when an event handler completes, and
the daemon re-attaches to the same session ID on the next event
to keep conversation context.

A task record carries:

- the canonical identifier (e.g. `github:owner/repo#123`,
  `linear:TEAM-456`)
- the worktree path (per `do-work-protocol.md`'s path convention)
- the last-known PR / ticket head SHA or revision marker
- the **runner session ID** assigned by the agent runner the
  first time the daemon spawned for this task (used with the
  runner's resume mechanism on every subsequent event)
- the active subscriptions (which watch subprocesses or SDK
  watch handles, if any, are currently driving it)
- the most recent heartbeat timestamp
- whether a live runner process is currently acting on the task,
  and that process's PID
- the **pending follow-up** record — a mutable accumulator of
  changes that arrived while a live runner was acting (see
  "Mutable follow-up" below)

The daemon does not store the agent's conversation history — the
runner owns that, keyed by session ID. The daemon stores only the
pointer needed to resume.

### State directory layout

The daemon's state directory is:

```
~/.local/state/dispatch/         (Linux, per XDG_STATE_HOME)
~/Library/Application Support/dispatch/   (macOS)
```

Inside it:

```
daemon.pid               # exclusive lock + PID
daemon.log               # rolling log
tasks/<id>.json          # one file per task, atomically replaced
events/<ts>-<id>.json    # event spool (drained on startup)
```

### Crash recovery

If the daemon crashes and restarts, it rehydrates tasks from
`tasks/` and replays any events queued in `events/`.

A task with a live runner at crash time is **not** silently
forgotten. The next external event might never arrive (e.g. the
crash interrupted a session in the middle of responding to a
review that already landed before the crash). On restart, the
daemon detects every task whose state recorded a live runner
PID, treats the prior runner process as gone, and immediately
spawns a fresh runner invocation for that task — resuming the
recorded session ID, with a `daemon-restart` event payload
describing what was interrupted. This guarantees in-flight work
is picked up without waiting for an external trigger.

## Event sources

The daemon reacts to three kinds of input:

1. **GitHub** — PR comment created, PR review submitted, check
   run completed, PR state changed (ready for review, merged,
   closed).
2. **Linear** (or whatever ticket tracker is configured) — issue
   assigned, comment added, state changed.
3. **CI watch** — a CI provider's notion of "this run finished"
   for the heads the daemon is tracking. Buildkite is the
   first-class case; GitHub Actions runs are folded into the
   GitHub event source.

Each source is implemented as an adapter that the daemon manages
via the orchestration strategies below.

### Orchestration strategy

The strategy is **layered**, in preference order:

1. **SDK watch / streaming API** when the source's SDK exposes
   one. The daemon holds the SDK watch handle in-process; no
   subprocess is spawned.
2. **Long-running watch subprocess** when only a CLI watch
   command exists. The daemon spawns the subprocess and consumes
   its exit (or streamed stdout) to drive events.
3. **Polling** as a last resort, with a dynamic interval (see
   below).

| Source                 | Default strategy                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| GitHub PR / issue      | Polling (no streaming subscription in `gh`); dynamic cadence per stage.                                |
| GitHub check rollup    | Watch via `gh pr checks --watch` subprocess per task with active CI; exit drives a `ci-finished` event. |
| Buildkite build        | Watch via `bk build wait` (or `buildkite-agent` equivalent) subprocess; exit drives event.             |
| Linear                 | Polling (no streaming on the Linear CLI); dynamic cadence per stage.                                   |

If a new adapter ships with an SDK watch API, it MUST be used in
preference to spawning a separate process. The subprocess and
polling fallbacks remain available for sources without that
support.

### Dynamic polling intervals

Polling cadence is not a single fixed number. The daemon adapts
the interval per task based on what stage the work is in, since
different stages have characteristic latencies:

| Stage                                          | Default base interval | Notes                                                    |
| ---------------------------------------------- | --------------------- | -------------------------------------------------------- |
| Awaiting Copilot review                        | 30s                   | Copilot typically returns in ~5 min; tighten near that.  |
| Awaiting CI on an active head                  | 60s                   | Buildkite runs average ~20 min; tighten near completion. |
| Awaiting human reviewer                        | 5 min                 | Human latency is long; aggressive polling wastes API.    |
| Awaiting ticket transition                     | 5 min                 | Tracker state changes are infrequent.                    |
| Idle (no in-flight work, just monitoring)      | 15 min                | Low cost, just a liveness check.                         |

Within each stage, the daemon SHOULD tighten the interval near
known high-likelihood transition points (e.g. when a Buildkite
build is approaching its historical mean duration, when a Copilot
review has been pending the typical 4–6 minutes). The exact
heuristic is implementation-defined; the design constraint is
that intervals must be data-driven, not constant.

### Watch reliability

A watch subprocess or SDK watch handle that fails (crash,
network drop, CLI misuse, dropped stream) is restarted with
capped backoff (2s, 4s, 8s, capped at 60s). The daemon does NOT
silently downgrade to polling on repeated failure — if the
chosen strategy cannot stay healthy, that is a configuration
problem the user needs to know about, and the daemon logs and
keeps retrying with the capped backoff.

## Spawning the runner

The agent runner is **not hardcoded** to `claude`. The daemon
treats the runner as a configurable component so that an
in-house CLI, OpenCode, or any other compatible runner can be
substituted without changing the daemon. The runner is
configured in `~/.config/dispatch/config.toml`:

```toml
[runner]
binary = "claude"                          # default
permissions = "bypass"                     # bypass | allowlist | inherit
resume_flag = "--resume"                   # how to resume by session id
session_id_capture = "stdout-jsonline"     # how the daemon learns the new session id on first run
extra_args = ["--dangerously-skip-permissions"]
```

The default configuration targets Claude Code with
`--dangerously-skip-permissions`, because the daemon runs
unattended: an interactive permission prompt would hang the
session forever. The `start` command warns explicitly on first
run and refuses to start if the user has not acknowledged the
permission posture (one-time confirmation persisted in the state
directory).

### Spawn contract

When an event handler decides to act, it invokes the configured
runner. Conceptually:

```
<runner.binary> <runner.extra_args> \
       [<runner.resume_flag> <session-id>]   # only on resume
       --cwd <task worktree> \
       --prompt-file <resolved prompt path> \
       --env DISPATCH_TASK_ID=<id> \
       --env DISPATCH_EVENT=<event kind> \
       --env DISPATCH_EVENT_PAYLOAD=<path to event json>
```

Key points:

- **Session resume.** On the first spawn for a task, no resume
  flag is passed; the daemon captures the new session ID from
  the runner's stdout (per `session_id_capture`) and persists
  it on the task record. On every subsequent spawn, the daemon
  passes `--resume <session-id>` (or the runner's equivalent),
  so the agent retains context across events.
- **Working directory** is the task's worktree per
  `do-work-protocol.md`'s path convention. The daemon refuses
  to spawn into a non-worktree (e.g. the user's main checkout);
  if no worktree exists yet for the task, the prompt for the
  triggering event is `bootstrap`, which is responsible for
  creating it.
- **Event payload** is passed by path, not on the command line.
  The handler writes a JSON file under `events/` containing the
  raw event (or coalesced set of events — see "Mutable
  follow-up") from the source adapter; the prompt template
  references the path through the `DISPATCH_EVENT_PAYLOAD` env
  var. Passing by path keeps argv short and avoids quoting hell.
- **Stdio** is captured to `daemon.log` with a task-id prefix.
  The runner has no TTY; anything the agent prints to stdout is
  log output (plus any structured channel the runner uses for
  session-id capture).

The daemon waits for the runner to exit before marking the event
handled. A runner exit code other than zero is logged but does
not re-trigger automatically — the next real event for the task,
or a subsequent crash-recovery restart, is what wakes the agent
up again.

## Prompts

Each event kind has a corresponding prompt template. Templates
MAY be authored in XML or in Markdown; XML is preferred for new
templates (more robust at delimiting content the agent should
treat as data versus instruction), but Markdown remains accepted
for parity with how existing protocol prompts in this repo are
authored. Both forms support mustache-style placeholders
(`{{event.author}}`).

### Resolution order

For a given event kind `<event>`, the daemon resolves the
template path in this order, taking the first that exists.
Within each location, `<event>.xml` is preferred over
`<event>.md`:

1. `<repo>/.dispatch/prompts/<event>.{xml,md}` — per-repo
   override, checked into the repository
2. `~/.config/dispatch/prompts/<event>.{xml,md}` — per-user
   override (on macOS, `~/Library/Application
   Support/dispatch/prompts/<event>.{xml,md}` is also accepted
   as an alias)
3. the bundled default shipped with the daemon binary

The repo override exists so a project can tailor what its
agents do for a given event. The home-dotdir override applies
personal preferences across every repo a user touches. Built-in
defaults exist so a fresh install works with zero configuration.

Resolution is per-event: a repo MAY override `pr-comment.xml`
without touching `ci-finished.xml`, and the daemon will mix
repo, home, and built-in templates for a single task without
ceremony.

### Scaffolding overrides

To make overrides ergonomic, the CLI provides:

```
dispatch prompts list                          # show every event and which template wins
dispatch prompts copy <event> [--repo|--home]  # copy the bundled default to the override location
dispatch prompts diff <event>                  # show the active override versus the bundled default
```

`dispatch prompts copy pr-comment --repo` writes
`.dispatch/prompts/pr-comment.xml` into the current repo's root
with the bundled default's contents, so the user has a starting
point to edit instead of authoring from scratch.

### Event-kind taxonomy

The initial set of event kinds the daemon dispatches on:

| Event              | Trigger                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `bootstrap`        | First time the daemon sees a task with no worktree (e.g. ticket assigned)            |
| `pr-comment`       | New top-level PR comment, or reply on an existing inline thread                      |
| `pr-review`        | A review was submitted (approve / request-changes / comment)                         |
| `ci-finished`      | Check rollup transitioned to a terminal state (success or failure)                   |
| `pr-state-change`  | Ready-for-review, converted-to-draft, merged, closed                                 |
| `ticket-comment`   | New comment on a tracked ticket                                                      |
| `ticket-state`     | Tracker-side state transition (assigned, moved into / out of an active state)        |
| `heartbeat`        | Internal — fired on the heartbeat cadence so `do-work-protocol.md`'s monitoring      |
|                    | requirement produces log lines even when no external event has arrived               |
| `daemon-restart`   | Synthetic — fired after crash recovery to resume a session that was live at crash    |

New event kinds may be added later. The taxonomy is the daemon's
public surface for prompt overrides; renaming an existing kind is
a breaking change.

## Concurrency and follow-ups

The daemon enforces two invariants on runner execution:

1. **At most one live runner per task.** A task's session ID is
   not reentrant; concurrent invocations would corrupt
   conversation history and confuse the agent.
2. **A configurable cap on total live runners per machine**
   (default 4, override in `~/.config/dispatch/config.toml`).
   When the cap is reached, new event handlers wait and are
   admitted FIFO as live runners exit.

### Multiple changes per tick

A single polling tick (or a single SDK watch notification batch)
can surface multiple changes for the same task at once — for
example, a Copilot review and a CI failure that landed during
the same poll window. These are NOT delivered as separate
events. The daemon combines all changes discovered on one tick
into a single coalesced event payload, picks the most specific
applicable prompt template (e.g. `pr-coalesced` rather than
either `pr-review` or `ci-finished`), and invokes the runner
once. `pr-status-protocol.md`'s actionability rules let the
agent reason about a combined PR state without the daemon
having to fan changes out into separate handlers.

### Mutable follow-up

If a new change is observed for a task while a runner is already
live, the daemon does **not** enqueue a separate event. Instead
it mutates the task's `pending_followup` record — a single
accumulator that grows as more changes arrive. The structure is
roughly:

```jsonc
{
  "since": "2026-05-12T05:54:00Z",       // when the live runner started
  "events": [ /* every change observed since 'since' */ ],
  "kill_threshold_met": false             // see "Pre-emptive resume"
}
```

When the live runner exits, the daemon checks
`pending_followup`. If non-empty, it spawns the runner again
(resuming the same session ID) with the accumulated events as
the payload, and clears the accumulator. The agent sees one
follow-up invocation that summarizes everything that happened
during its prior run, rather than a queue of per-event
invocations to slog through.

### Pre-emptive resume

Under most circumstances the daemon waits for the live runner to
exit naturally before spawning the follow-up. But when an
incoming change is significant enough that continuing the
current invocation is wasteful — for example, the PR was closed,
or a force-push invalidated the commits the agent was reasoning
about — the daemon MAY kill the live runner with SIGTERM and
immediately resume the session with the combined context.
Pre-emption is gated on `kill_threshold_met`, set by the source
adapter when it observes a class-of-change marked as
session-invalidating. The default kill-threshold classes are PR
closure, base-branch change, and force-push detected on the
work branch. Other classes can be added per-deployment via the
config file.

## Heartbeats

The daemon fires a `heartbeat` event for every monitored task on
a configurable cadence (default 10 minutes). The heartbeat
handler resumes the task's session for a short turn whose only
job is to emit the operational log line required by
`ticket-workflow-protocol.md` and update the task's heartbeat
timestamp. Tasks with no tracked ticket emit `ticket=-` per that
protocol.

A heartbeat is suppressed when the task has had any other event
within the heartbeat window — the protocol's intent is that an
external observer sees evidence of life, not that the agent
produces noise.

## Lifecycle

### Start

`dispatch daemon start` does, in order:

1. Take the exclusive PID lock at `<state>/daemon.pid`. Refuse
   to start if another daemon holds it.
2. Verify required CLIs are present and authenticated (see
   "Required CLIs" below). Refuse to start on failure.
3. Rehydrate tasks from `<state>/tasks/`.
4. Replay events from `<state>/events/` against the rehydrated
   tasks, oldest first.
5. For every task that records a live runner PID, synthesize a
   `daemon-restart` event and queue it.
6. Re-attach watch subprocesses and SDK watch handles for tasks
   whose state recorded active subscriptions.
7. Begin the polling loop.
8. Detach from the terminal (unless `--foreground` was passed).

### Stop

`dispatch daemon stop` sends SIGTERM. The daemon:

1. Stops accepting new events.
2. Waits up to 30 seconds for in-flight runners to exit
   naturally.
3. Sends SIGTERM to any remaining runners (they have their own
   cleanup logic per the protocols).
4. Persists final task state.
5. Releases the PID lock and exits.

`dispatch daemon stop --force` skips the wait and sends SIGTERM
immediately. Tasks whose runners were acting at the time are
left in whatever state they reached and will be resumed via
`daemon-restart` on the next start.

### Status

`dispatch daemon status` prints a one-line summary per task
(id, current stage, last heartbeat, whether a runner is live)
plus daemon-wide counters (events handled, runners spawned,
watch handles alive, pending follow-ups). This is the
developer's primary read-out for what the daemon is doing.

## Distribution

The daemon ships as a single prebuilt binary per target:

- `dispatch-darwin-arm64`
- `dispatch-darwin-x64`
- `dispatch-linux-x64`
- `dispatch-linux-arm64`

Windows is not a target for the initial release. Built-in
default prompt templates are embedded into the binary at build
time so a fresh install works without a separate assets bundle.
The binary is installed by the `dispatch` plugin's install hook
into `~/.local/bin/dispatch` (Linux) or `~/Library/Application
Support/dispatch/bin/dispatch` (macOS) and symlinked onto the
user's `PATH` if the install hook detects a writable bin
directory.

### Required CLIs

The daemon depends on the following external CLIs being
available on `PATH` at runtime, authenticated, and able to
answer a no-op probe (`gh auth status`, `bk current-user`,
etc.):

- the configured runner (`claude` by default; whatever
  `runner.binary` resolves to)
- `git` — worktree creation, branch operations
- `gh` — GitHub event reads and PR check watch
- `bk` (or `buildkite-agent`) — Buildkite watch, when the repo
  uses Buildkite
- the tracker CLI for whatever ticket system is configured

A missing or unauthenticated CLI is a fatal startup error: the
daemon logs which CLI failed which probe, exits non-zero, and
does NOT proceed in a degraded mode. The user is expected to
install or authenticate the CLI and re-invoke
`dispatch daemon start`. The intent is that the daemon never
runs in a half-functional state where some tasks are silently
ignored.

If a previously-required CLI becomes unavailable at runtime
(uninstalled, token expired), the affected source adapter
surfaces a fatal error on its next operation; the daemon stops
accepting new events for that source, logs the failure, and
exits at the next clean stopping point. There is no
silently-disabled mode.

## Cross-references

- `agent-communication-protocol.md` — wire format every agent
  session the daemon spawns is required to follow.
- `pr-status-protocol.md` — read-side rules the daemon's event
  sources implement, the actionability vocabulary that informs
  coalescing, and the cache the polling adapters keep.
- `ticket-workflow-protocol.md` — operational log format the
  heartbeat handler emits, and the state vocabulary the
  daemon's ticket adapter maps onto.
- `do-work-protocol.md` — the worktree, PR-open, monitoring,
  and termination rules every spawned session is required to
  honor.
