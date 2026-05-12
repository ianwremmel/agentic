# Daemon Orchestration

This document describes the design of the **dispatch daemon** — a
long-running operational driver that spawns Claude Code sessions in
response to external events, so an agent can monitor work without a
human keeping a terminal open. It is a design doc, not a protocol:
the existing protocol docs (`agent-communication-protocol.md`,
`pr-status-protocol.md`, `ticket-workflow-protocol.md`,
`do-work-protocol.md`) define what an agent emits and observes; this
doc defines the process that wakes the agent up so it can do those
things.

The existing protocols are deliberately silent on "the agent's
operational driver, event subscription, polling loop, etc." (see
`do-work-protocol.md` § Scope). This design fills exactly that gap.

## Why this exists

A single Claude Code session is interactive: a human starts it,
types into it, and closes it. Real engineering work doesn't fit in
one session. CI takes minutes; reviewers take hours; tickets sit
between humans for days. The protocols require the agent to monitor
PRs and tickets across those gaps and react to new events — but
nothing in the protocols actually keeps a process alive between
events.

The daemon fills that role. It runs in the background on a
developer machine (or a long-lived sandbox), subscribes to the
event sources the protocols read from, and spawns a fresh Claude
Code session for each event with a prompt that tells the session
what just happened and which item to act on. The Claude session
does its work according to the protocols, exits, and the daemon
goes back to waiting.

## Scope

Covered:

- the daemon's process model (one daemon per machine, item state
  on disk, transient Claude sessions per event)
- event sources the daemon subscribes to and the orchestration
  strategy for each
- the prompt-template system (built-in defaults, repo override,
  home-dotdir override) and the resolution order
- the spawn contract for Claude Code sessions (permission mode,
  working directory, env, stdio)
- concurrency, dedup, and crash-recovery rules
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

There is a single daemon process per machine. Multiple Claude
sessions or repositories share it. Running two daemons on the same
machine is forbidden — the daemon takes an exclusive PID lockfile
on startup and refuses to start if another instance holds it.

The daemon is not a system service. It is launched by the user
(typically through a `dispatch daemon start` command, a login
agent on macOS, or a user-level systemd unit on Linux) and runs
under the invoking user's account, with that user's credentials
for GitHub, Linear, and any other platform the protocols touch.

### Items, not sessions, are the unit of state

The persistent unit is an **item** — one PR or one ticket the
daemon is monitoring. Items live in the daemon's state directory
between events. A Claude session is transient: it exists only for
the duration of one event handler, then exits.

An item record carries:

- the canonical identifier (e.g. `github:owner/repo#123`,
  `linear:TEAM-456`)
- the worktree path (per `do-work-protocol.md`'s path convention)
- the last-known PR / ticket head SHA or revision marker
- the active subscriptions (which watch subprocesses, if any, are
  currently driving it)
- the most recent heartbeat timestamp
- whether the item is currently being acted on by a live Claude
  session, and that session's PID

The daemon does not store conversation history or any Claude
internal state. Each Claude session is responsible for
reconstructing the context it needs from the PR / ticket /
worktree.

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
items/<id>.json          # one file per item, atomically replaced
events/<ts>-<id>.json    # pending event queue (drained on startup)
```

State on disk is the recovery boundary: if the daemon crashes and
restarts, it rehydrates items from `items/` and replays any events
queued in `events/`. Live Claude sessions that were running at the
moment of crash are not resumed — they are treated as if they had
exited without effect, and the next event for the item will spawn
a fresh session that picks up from the PR / ticket state.

## Event sources

The daemon reacts to three kinds of input:

1. **GitHub** — PR comment created, PR review submitted, check run
   completed, PR state changed (ready for review, merged, closed).
2. **Linear** (or whatever ticket tracker is configured) — issue
   assigned, comment added, state changed.
3. **CI watch** — a CI provider's notion of "this run finished"
   for the heads the daemon is tracking. Buildkite is the
   first-class case; GitHub Actions runs are folded into the
   GitHub event source.

Each source is implemented as an adapter that the daemon manages
via the orchestration strategies below.

### Orchestration strategy

The strategy is **hybrid**: prefer a long-running watch subprocess
when the underlying CLI supports one, fall back to polling
otherwise.

| Source                 | Strategy                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| GitHub PR / issue      | Polling. `gh` does not expose a streaming subscription; the daemon polls per-item on a 30s cycle.  |
| GitHub check rollup    | `gh pr checks --watch` subprocess per item with active CI; exit drives a `ci-finished` event.      |
| Buildkite build        | `bk build wait` (or `buildkite-agent` equivalent) subprocess per active build; exit drives event.  |
| Linear                 | Polling. The Linear CLI does not stream; the daemon polls per-item on a 60s cycle.                 |

The daemon collapses near-simultaneous events for the same item
into one handler invocation (see "Concurrency and dedup" below)
so the polling cadence does not become a stampede.

A watch subprocess that exits non-zero (crash, network drop, CLI
misuse) is restarted with capped backoff (2s, 4s, 8s, capped at
60s). Repeated failures over a 5-minute window degrade that item
to polling-only for the rest of the daemon's lifetime; an entry
is written to `daemon.log`.

## Spawning Claude

When an event handler decides to act, it spawns a fresh Claude
Code session:

```
claude --dangerously-skip-permissions \
       --cwd <item worktree> \
       --prompt-file <resolved prompt path> \
       --env DISPATCH_ITEM_ID=<id> \
       --env DISPATCH_EVENT=<event kind> \
       --env DISPATCH_EVENT_PAYLOAD=<path to event json>
```

Key points:

- **`--dangerously-skip-permissions`** is required. The daemon
  runs unattended; an interactive permission prompt would hang
  the session forever, leaving the item in a half-acted-on state.
  The user accepts this trade-off when they install and start
  the daemon. The daemon's `start` command warns about it
  explicitly on first run and refuses to start if the user has
  not acknowledged it (one-time confirmation persisted in the
  state directory).
- **Working directory** is the item's worktree per
  `do-work-protocol.md`'s path convention. The daemon refuses to
  spawn into a non-worktree (e.g. the user's main checkout); if
  no worktree exists yet for the item, the prompt for the
  triggering event is `bootstrap.md`, which is responsible for
  creating it.
- **Event payload** is passed by path, not on the command line.
  The handler writes a JSON file under `events/` containing the
  raw event from the source adapter; the prompt template
  references the path through the `DISPATCH_EVENT_PAYLOAD` env
  var. Passing by path keeps argv short and avoids quoting hell.
- **Stdio** is captured to `daemon.log` with an item-id prefix.
  The session has no TTY; anything the agent prints to stdout is
  log output, not user-facing.

The daemon waits for the session to exit before marking the event
handled. A session that exits non-zero is logged but does not
re-trigger automatically — the next real event for the item is
what wakes the agent up again. This avoids retry loops on
permanent failures (e.g. an unresolvable prompt-template error).

## Prompts

Each event kind has a corresponding prompt template. Templates
are Markdown files that may reference environment variables and
event-payload fields via mustache-style placeholders (`{{event.author}}`).

### Resolution order

For a given event kind `<event>`, the daemon resolves the template
path in this order, taking the first that exists:

1. `<repo>/.dispatch/prompts/<event>.md` — per-repo override,
   checked into the repository
2. `~/.config/dispatch/prompts/<event>.md` — per-user override,
   on the developer's machine (XDG-style; on macOS,
   `~/Library/Application Support/dispatch/prompts/<event>.md`
   is also accepted as an alias)
3. the bundled default shipped with the daemon binary

The repo override exists so a project can tailor what its agents
do for a given event (e.g. "before responding to a Copilot
comment, always run `make typecheck`"). The home-dotdir override
exists so a user can apply personal preferences across every repo
they touch. Built-in defaults exist so a fresh install works with
zero configuration.

The resolution is per-event: a repo MAY override `pr-comment.md`
without touching `ci-finished.md`, and the daemon will mix repo,
home, and built-in templates for a single item without ceremony.

### Event-kind taxonomy

The initial set of event kinds the daemon dispatches on:

| Event              | Trigger                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `bootstrap`        | First time the daemon sees an item with no worktree (e.g. ticket assigned)       |
| `pr-comment`       | New top-level PR comment, or reply on an existing inline thread                  |
| `pr-review`        | A review was submitted (approve / request-changes / comment)                     |
| `ci-finished`      | Check rollup transitioned to a terminal state (success or failure)               |
| `pr-state-change`  | Ready-for-review, converted-to-draft, merged, closed                             |
| `ticket-comment`   | New comment on a tracked ticket                                                  |
| `ticket-state`     | Tracker-side state transition (assigned, moved into / out of an active state)    |
| `heartbeat`        | Internal — fired on the heartbeat cadence so `do-work-protocol.md`'s monitoring  |
|                    | requirement produces log lines even when no external event has arrived           |

New event kinds may be added later. The taxonomy is the daemon's
public surface for prompt overrides; renaming an existing kind is
a breaking change.

## Concurrency and dedup

The daemon enforces two invariants on Claude session execution:

1. **At most one live Claude session per item.** If an event
   arrives for an item that already has a live session, the
   event is queued. When the live session exits, the daemon
   collapses any queued events for that item into a single
   "catch up" handler invocation, with a `pr-coalesced` event
   payload listing what was missed. The catch-up handler is
   responsible for reading current PR state and reacting; it
   does not replay each queued event individually.
2. **A configurable cap on total live sessions per machine**
   (default 4, override in `~/.config/dispatch/config.toml`).
   When the cap is reached, new event handlers queue
   machine-wide and are admitted FIFO as live sessions exit.

The dedup boundary is the item, not the event. Two CI-finished
events for the same PR head produce one session invocation, not
two — the second is dropped on the floor as redundant. Two events
of different kinds for the same item produce one session — the
later event wins on prompt selection, and the earlier event's
payload is included in the catch-up.

## Heartbeats

The daemon fires a `heartbeat` event for every monitored item on
a configurable cadence (default 10 minutes). The heartbeat
handler spawns a short-lived Claude session whose only job is to
emit the operational log line required by
`ticket-workflow-protocol.md` and update the item's heartbeat
timestamp in the daemon's state. Items with no tracked ticket
emit `ticket=-` per that protocol.

A heartbeat is suppressed when the item has had any other event
within the heartbeat window — the protocol's intent is that an
external observer sees evidence of life, not that the agent
produces noise.

## Lifecycle

### Start

`dispatch daemon start` does, in order:

1. Take the exclusive PID lock at `<state>/daemon.pid`. Refuse
   to start if another daemon holds it.
2. Rehydrate items from `<state>/items/`.
3. Replay events from `<state>/events/` against the rehydrated
   items, oldest first.
4. Re-attach watch subprocesses for items whose state recorded
   active subscriptions.
5. Begin the polling loop.
6. Detach from the terminal (unless `--foreground` was passed).

### Stop

`dispatch daemon stop` sends SIGTERM. The daemon:

1. Stops accepting new events.
2. Waits up to 30 seconds for in-flight Claude sessions to
   exit naturally.
3. Sends SIGTERM to any remaining sessions (they have their own
   cleanup logic per the protocols).
4. Persists final item state.
5. Releases the PID lock and exits.

`dispatch daemon stop --force` skips the wait and sends SIGTERM
to in-flight sessions immediately. Items they were acting on are
left in whatever state they reached.

### Status

`dispatch daemon status` prints a one-line summary per item
(id, current state, last heartbeat, whether a session is live)
plus daemon-wide counters (events handled, sessions spawned,
watch subprocesses alive). This is the developer's primary
read-out for what the daemon is doing.

## Distribution

The daemon ships as a single prebuilt binary per target:

- `dispatch-darwin-arm64`
- `dispatch-darwin-x64`
- `dispatch-linux-x64`
- `dispatch-linux-arm64`

Windows is not a target for the initial release. Built-in default
prompt templates are embedded into the binary at build time so a
fresh install works without a separate assets bundle. The binary
is installed by the `dispatch` plugin's install hook into
`~/.local/bin/dispatch` (Linux) or `~/Library/Application
Support/dispatch/bin/dispatch` (macOS) and symlinked onto the
user's `PATH` if the install hook detects a writable bin
directory.

The daemon depends on the following external CLIs being available
on `PATH` at runtime:

- `claude` — Claude Code itself
- `git` — worktree creation, branch operations
- `gh` — GitHub event reads and PR check watch
- `bk` (or `buildkite-agent`) — Buildkite watch, when the repo
  uses Buildkite
- the tracker CLI for whatever ticket system is configured

Missing CLIs degrade specific event sources to "unavailable" with
an entry in `daemon.log`; the daemon keeps running for the
sources that remain functional.

## Cross-references

- `agent-communication-protocol.md` — wire format every Claude
  session the daemon spawns is required to follow.
- `pr-status-protocol.md` — read-side rules the daemon's event
  sources implement, and which spawned sessions use to interpret
  PR state.
- `ticket-workflow-protocol.md` — operational log format the
  heartbeat handler emits, and the state vocabulary the daemon's
  ticket adapter maps onto.
- `do-work-protocol.md` — the worktree, PR-open, monitoring, and
  termination rules every spawned session is required to honor.
