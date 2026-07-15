# §3.1.2 — Daemon: Normative

## Process model

### Single instance

There MUST be at most one daemon process per machine. The daemon MUST acquire an
exclusive PID lock on startup:

1. Attempt `LOCK_EX | LOCK_NB` on `<state>/daemon.pid`.
2. If the lock is held by a live process, refuse to start.
3. If the lock is free but the file exists (stale lockfile from a prior crash),
   confirm via `kill -0` that no process with the recorded PID is running, then
   overwrite the file and take the lock.

Concurrent live daemons are forbidden. Stale lockfiles MUST NOT block startup.

### State directory

| Platform | Default path                                 |
| -------- | -------------------------------------------- |
| Linux    | `$XDG_STATE_HOME/dispatch` or `~/.local/state/dispatch` |
| macOS    | `~/Library/Application Support/dispatch`     |

Layout:

```text
daemon.pid
daemon.log
tasks/<encoded-id>.json
events/<ts>-<encoded-id>.json
```

**Filename encoding.** Canonical task IDs (e.g. `github:owner/repo#123`) contain
characters unsafe in filenames. The daemon encodes them by percent-encoding every
byte not in `[A-Za-z0-9._-]`, lowercase. The canonical ID is preserved verbatim
inside the JSON.

### Task record

Each `tasks/<encoded-id>.json` carries:

| Field                | Contents                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| `id`                 | Canonical task identifier (e.g. `github:owner/repo#123`)                |
| `worktree`           | Absolute path to the task's git worktree                                |
| `head`               | Last-known PR or ticket head SHA / revision marker                      |
| `session_id`         | Runner session ID assigned on first spawn                               |
| `subscriptions`      | Active watch subprocess PIDs or SDK watch handle descriptors            |
| `last_heartbeat`     | RFC 3339 timestamp of the most recent heartbeat log entry               |
| `live_runner_pid`    | PID of a currently-running runner process, or null                      |
| `pending_followup`   | Mutable accumulator of changes that arrived while a runner was live     |

The daemon MUST NOT store conversation history; that is owned by the runner,
keyed by session ID.

### Crash recovery

On startup, the daemon MUST:

1. Rehydrate all tasks from `tasks/`.
2. Replay queued events from `events/` oldest-first.
3. For every task whose `live_runner_pid` is set, synthesize a `daemon-restart`
   event and queue it immediately.
4. Re-attach watch subprocesses and SDK handles for tasks with active
   subscriptions.

## Spawn contract

### Runner configuration

The runner is configured in `~/.config/dispatch/config.json`
(implementation-defined format; JSON shown as example):

```json
{
  "runner": {
    "binary": "claude",
    "permissions": "bypass",
    "resume_flag": "--resume",
    "session_id_capture": "stdout-jsonline",
    "extra_args": ["--dangerously-skip-permissions"]
  }
}
```

The daemon MUST NOT hardcode `claude` as the binary. Any compatible runner
satisfying the spawn contract MUST be accepted.

### Invocation shape

```shell
<runner.binary> <runner.extra_args>
    [<runner.resume_flag> <session-id>]   # only on resume
    --cwd <task-worktree>
    --prompt-file <resolved-prompt-path>
    --env DISPATCH_TASK_ID=<id>
    --env DISPATCH_EVENT=<event-kind>
    --env DISPATCH_EVENT_PAYLOAD=<path-to-event-json>
```

- On the **first spawn** for a task, no resume flag is passed. The daemon MUST
  capture the new session ID from the runner's output (per `session_id_capture`)
  and persist it on the task record.
- On every **subsequent spawn**, the daemon MUST pass the resume flag and the
  stored session ID.
- The working directory MUST be the task's worktree. The daemon MUST create the
  worktree before invoking the runner. If no worktree exists for a new task, the
  daemon creates it as part of processing the `bootstrap` event, before the
  runner is spawned.
- The event payload MUST be written as a JSON file under `events/` and passed by
  path, not on the command line.
- Stdio MUST be captured to `daemon.log` with a task-id prefix. The runner has
  no TTY.

### Non-zero exits

The daemon handles runner non-zero exits in two tiers:

1. **Hard-coded triage.** Runner binary not found, usage error, prompt resolution
   failure, OOM. These produce a logged failure and either a clean abort (config
   error: stop accepting events for this task) or an immediate retry with capped
   backoff (transient resource issue).

2. **Triage prompt.** For all other non-zero exits, the daemon MUST synthesize a
   `runner-error` event carrying the exit code, the tail of the runner's
   stdout/stderr, and the original event payload, then re-invoke the runner
   against the `runner-error` prompt template. The triage prompt MUST NOT
   silently swallow the failure.

## Event taxonomy

| Event              | Trigger                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `bootstrap`        | First time the daemon sees a task with no worktree                                  |
| `pr-comment`       | New top-level PR comment or reply on an existing inline thread                      |
| `pr-review`        | A review submitted (approve / request-changes / comment)                            |
| `ci-finished`      | Check rollup transitioned to a terminal state (success or failure)                  |
| `pr-state-change`  | Ready-for-review, converted-to-draft, merged, or closed                             |
| `ticket-comment`   | New comment on a tracked ticket                                                     |
| `ticket-state`     | Tracker-side state transition (assigned, moved into / out of an active state)       |
| `heartbeat`        | Internal — fired on the heartbeat cadence to satisfy §2.4 monitoring requirement   |
| `daemon-restart`   | Synthetic — fired after crash recovery for tasks with a live runner at crash time   |
| `runner-error`     | Synthetic — fired when the runner exits non-zero outside the hard-coded triage set  |
| `pr-coalesced`     | Synthetic — two or more PR-side base events on the same tick or follow-up           |
| `ticket-coalesced` | Synthetic — same as `pr-coalesced` for ticket-side events                           |

Renaming an existing event kind is a breaking change. New event kinds MAY be
added.

## Concurrency limits

The daemon MUST enforce:

1. **At most one live runner per task.** Concurrent invocations of the same
   session ID are forbidden.
2. **A configurable cap on total live runners per machine** (default 4). When the
   cap is reached, incoming event handlers MUST wait and be admitted FIFO as
   runners exit.

### Mutable follow-up

When a change is observed for a task while a runner is live, the daemon MUST NOT
enqueue a separate event. It MUST accumulate the change into the task's
`pending_followup` record. When the runner exits, if `pending_followup` is
non-empty, the daemon MUST immediately spawn the runner again with the accumulated
events as the payload and clear the accumulator.

### Coalescing

Changes discovered on the same polling tick MUST be combined into a single event:

- One base event → that event's kind (no coalescing).
- Two or more PR-side events → `pr-coalesced`.
- Two or more ticket-side events → `ticket-coalesced`.
- Mixed PR-side and ticket-side → `pr-coalesced`.

The coalesced payload MUST include every original base event.

### Pre-emptive resume

When an incoming change is classified as session-invalidating (PR closure,
base-branch change, force-push on the work branch), the daemon MAY send SIGTERM
to the live runner and immediately spawn a follow-up with the combined context.
Additional session-invalidating classes MAY be configured per-deployment.

## Prompt resolution

For a given event kind `<event>`, the daemon MUST resolve the template in this
order, taking the first that exists. Within each location, `.xml` is preferred
over `.md`:

1. `<repo>/.dispatch/prompts/<event>.{xml,md}`
2. `~/.config/dispatch/prompts/<event>.{xml,md}`
3. Built-in default bundled in the daemon binary

## Heartbeats

The daemon MUST fire a `heartbeat` event for every monitored task on a
configurable cadence (default 10 minutes). A heartbeat MUST be suppressed when
any other event for the same task was handled within the heartbeat window.

The heartbeat handler MUST emit the operational log line required by §2.3 and
MUST update the task's `last_heartbeat` timestamp.

## Event-source orchestration

For each event source, the daemon MUST use the least-expensive available strategy:

1. SDK watch / streaming API (preferred).
2. Watch subprocess (CLI in `--watch` mode).
3. Polling (fallback).

| Source              | Default strategy                                                         |
| ------------------- | ------------------------------------------------------------------------ |
| GitHub PR / issue   | Polling; dynamic cadence per stage                                       |
| GitHub check rollup | `gh pr checks --watch` subprocess per task with active CI                |
| Buildkite build     | `bk build wait` subprocess                                               |
| Linear              | Polling; dynamic cadence per stage                                       |

Dynamic polling intervals:

| Stage                              | Default interval                           |
| ---------------------------------- | ------------------------------------------ |
| Awaiting Copilot review            | 30 s                                       |
| Awaiting CI on an active head      | 60 s once, then 5 min                      |
| Awaiting human reviewer            | 5 min                                      |
| Awaiting ticket transition         | 5 min                                      |
| Idle (monitoring only)             | 15 min                                     |

The daemon SHOULD tighten the interval near known high-likelihood transition
points. Intervals MUST be data-driven, not constant.

A watch subprocess or SDK handle that fails MUST be restarted with capped backoff
(2s, 4s, 8s, cap 60s). The daemon MUST NOT silently downgrade to polling on
repeated failure.

## Lifecycle

### Start (`dispatch daemon start`)

1. Acquire the daemon PID lock.
2. Verify required CLIs are present and authenticated. MUST refuse to start on
   failure.
3. Rehydrate tasks from `tasks/`.
4. Replay events from `events/`, oldest first.
5. Synthesize `daemon-restart` events for tasks with a recorded live runner PID.
6. Re-attach watch handles for tasks with active subscriptions.
7. Begin the polling loop.
8. Detach from the terminal (unless `--foreground` was passed).

Required CLIs: the configured runner binary, `git`, `gh`, the CI provider CLI
(e.g. `bk`), and the tracker CLI. A missing or unauthenticated CLI is a fatal
startup error. The daemon MUST NOT proceed in a degraded mode.

### Stop (`dispatch daemon stop`)

1. Stop accepting new events.
2. Wait up to 30 seconds for in-flight runners to exit.
3. Send SIGTERM to any remaining runners.
4. Persist final task state.
5. Release the PID lock and exit.

`dispatch daemon stop --force` sends SIGTERM immediately without waiting.

### Distribution

The daemon ships as a single prebuilt binary per target:

| Target                  |
| ----------------------- |
| `dispatch-darwin-arm64` |
| `dispatch-darwin-x64`   |
| `dispatch-linux-x64`    |
| `dispatch-linux-arm64`  |

Built-in default prompt templates MUST be embedded in the binary at build time.
Windows is not a supported target for the initial release.
