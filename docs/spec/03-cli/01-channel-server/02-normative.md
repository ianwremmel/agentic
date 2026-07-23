# §3.1.2 — Channel Server: Normative

The channel server is the `dispatch` CLI running in its long-lived server mode
(`dispatch mcp`). It is a Claude Code channel: an MCP server that pushes events
into the session that spawned it.

## Process model

### Per-session, not singleton

The server MUST run as one process per session, spawned by the session runner as
a stdio MCP subprocess. It MUST NOT acquire a machine-wide lock, and MUST NOT
assume it is the only server on the machine. Multiple servers — one per live
session — MUST be able to run concurrently against the shared graph DB (see
[Multi-session](#multi-session)).

The server's lifetime is bound to its session: it starts when the session starts
and exits when the session ends. There is no out-of-band start or stop.

### Orchestrator session and routed subagents

Channel events reach only the top-level session the runner spawned the server for,
and a subagent cannot be woken directly by a channel event. So a project runs as one
**orchestrator session** that owns the server; the server watches the graph and every
in-flight ticket's PRs and pushes all events to the orchestrator, which relays each
to a subagent — a coordinator subagent per `dispatch_ticket`, and the subagent
handling a PR for each PR/CI trigger (matched by `repo`/`pr`). A subagent MAY be
long-lived, going idle after each event and resumed by the orchestrator's message
when the next arrives, or short-lived, spawned per event. Either way the graph DB and
`dispatch pr-status` remain the source of truth: a subagent MUST be able to
reconstruct its state from them (this is also the recovery path after an orchestrator
restart), and the waiting MUST stay in the server — a subagent MUST NOT run a
foreground poll loop. This reconceives §2.6's continuously-running nested actors and
is subject to reconciliation with §2.6.

### Channel capability

The server MUST declare the channel capability
(`capabilities.experimental['claude/channel']`) so the runner registers a
notification listener. It pushes events by emitting `notifications/claude/channel`
(see [Channel message protocol](#channel-message-protocol)).

### Push-only; the graph DB is the backbone

The server MUST be push-only: correctness MUST NOT depend on the session calling
any server-exposed MCP tool. All session→server signalling MUST ride the shared
graph DB (§2.6) via ordinary `dispatch` command writes — recording a PR to watch,
marking a delegation handled, claiming work. The server observes these writes on
its poll tick. It MUST pick up a newly written watch or claim promptly — waking on
a DB change (a SQLite update hook or file watch), not only on a fixed interval — so
a just-registered PR takes effect within a second rather than a poll cycle later.

The server MUST NOT keep durable state of its own beyond the graph DB. On restart
it MUST rebuild its watch set from the DB: the spawning session's open claims and
its un-merged PRs.

### Mode marker

The server MUST make its presence detectable so skills can select channel vs
fallback mode. Because a channel subprocess cannot set an environment variable in
the agent's process, the marker MUST be injected by the runner (or carried in
plugin config) as a session id that both the server's registry row and `dispatch
mcp status` correlate on; `dispatch mcp status` MUST report channel mode active
only when a live server is registered for the current session. When the channel
capability is refused at startup (research-preview flag absent, non-Anthropic auth,
or `channelsEnabled` off), the server MUST report that condition rather than
failing the session, so skills fall back to polling.

## Channel message protocol

### Notification format

Each event is a `notifications/claude/channel` notification with `content` (the
tag body, a string) and `meta` (a string→string map rendered as tag attributes).
Every event MUST carry:

| Attribute | Source        | Meaning                                                        |
| --------- | ------------- | -------------------------------------------------------------- |
| `source`  | set by runner | The server name; not set by the server.                       |
| `kind`    | `meta`        | The event kind (tables below).                                 |
| `seq`     | `meta`        | Monotonic per-server sequence number for ordering/coalescing.  |

Additional `meta` keys are per-kind. Each key MUST consist only of letters,
digits, and underscores — an anchored `^[a-z0-9_]+$`. The channel layer silently
drops any key containing a hyphen or other character, so keys MUST NOT contain one
(`pr`, never `pr-number`). Values are strings.

Bodies MUST NOT be assembled from raw external text. A PR/CI event body MUST be
the `dispatch pr-status` payload for the referenced PR; a work-order body MUST be
a short instruction naming the work. This keeps the injected content identical to
what the session already reads through the CLI.

### Event catalog

**PR / CI triggers** — body is the `dispatch pr-status` payload for `repo`/`pr`.

| kind              | `meta` (beyond source/kind/seq)                                        | fires when                                          |
| ----------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| `ci_finished`     | `repo`, `pr`, `rollup` = `success` \| `failure` \| `error`            | the check rollup reaches a terminal state           |
| `pr_review`       | `repo`, `pr`, `state` = `approved` \| `changes` \| `comment`, `reviewer` | a review is submitted                            |
| `pr_comment`      | `repo`, `pr`, `thread`                                                 | a new top-level comment or inline reply lands       |
| `pr_state_change` | `repo`, `pr`, `state` = `ready` \| `draft` \| `merged` \| `closed`    | the PR changes lifecycle state                      |

**Work orders** — body is a short instruction naming the skill to run. The server
MUST do the graph reasoning (rank, gate, slot, and — for `dispatch_ticket` —
claim) before emitting one; the session executes it and MUST NOT need to read the
graph.

| kind                       | `meta` (beyond source/kind/seq) | asks the session to                                             |
| -------------------------- | ------------------------------- | -------------------------------------------------------------- |
| `dispatch_ticket`          | `project`, `ticket`             | coordinate the ticket (already claimed for this session, with a slot held) |
| `perform_milestone_review` | `project`, `milestone`          | review the milestone whose gate is open                        |
| `refresh_graph`            | `tracker`, `reason`             | run the graph producer over the tracker and write the delta, advancing the cursor (the server cannot read an MCP-only tracker) |
| `park_human_blocked`       | `project`, `ticket`             | move a human-blocked ticket to its parked state and post the handoff (a tracker write) |
| `alert_failure`            | `project`, `ticket`             | alert the operator that a ticket failed unrecoverably          |
| `project_complete`         | `project`                       | record and announce that the project's work is done            |

The last three carry the orchestrator tick's non-scheduling duties in §2.6
(surface anomalies, park human-blocked work, alert failures, decide completion):
the server detects the condition deterministically from the graph and the session
performs the part that needs a tracker write or an operator message. New event
kinds MAY be added. Renaming an existing kind is a breaking change.

### Ordering and coalescing

`seq` MUST increase monotonically per server. Changes of the **same kind on the
same PR** observed on one tick MUST be coalesced into a single event; changes that
differ in kind or PR MUST remain distinct events, since one event's
`kind`/`repo`/`pr` are single-valued and merging heterogeneous changes would lose
information. Events queued while the session is busy are delivered together on the
session's next turn, in `seq` order; the session MUST process them as an ordered
batch and, where an event may be stale by delivery time, re-read canonical state
through the corresponding `dispatch` command rather than acting on the body alone.

### Work the server cannot do itself

For any source the server cannot reach without an MCP client (a tracker exposed
only over MCP), the server MUST NOT attempt the fetch itself. It MUST push the
corresponding work order (`refresh_graph`) and treat the resulting `dispatch
graph` writes (observed on a later tick) as the completion signal. Because channel
notifications are not acknowledged, a `refresh_graph` that owns no claim MUST be
recorded durably — as a `refresh_due_at` on the tracker's cursor row — and the
server MUST re-derive owed refreshes from that on restart rather than assuming a
pushed order was delivered.

## Event-source orchestration

For each event source the server MUST use the least-expensive available strategy:

1. SDK watch / streaming API (preferred).
2. Watch subprocess (e.g. a `--watch`-mode CLI).
3. Polling (fallback).

| Source              | Default strategy                                                    |
| ------------------- | ------------------------------------------------------------------- |
| GitHub PR / issue   | Polling; dynamic cadence per stage                                  |
| GitHub check rollup | `gh pr checks --watch` subprocess per watched PR with active CI     |
| Buildkite build     | `bk build wait` subprocess                                          |
| Graph DB            | SQLite read on the poll tick                                        |

Dynamic polling intervals:

| Stage                              | Default interval                           |
| ---------------------------------- | ------------------------------------------ |
| Awaiting Copilot review            | 30 s                                       |
| Awaiting CI on an active head      | 60 s once, then 5 min                      |
| Awaiting human reviewer            | 5 min                                      |
| Awaiting ticket transition         | 5 min                                      |
| Idle (monitoring only)             | 15 min                                     |

The server SHOULD tighten the interval near known high-likelihood transition
points. Intervals MUST be data-driven, not constant. A watch subprocess or SDK
handle that fails MUST be restarted with capped backoff (2s, 4s, 8s, cap 60s);
the server MUST NOT silently downgrade to polling on repeated failure.

## Multi-session

Each participating session MUST run its own server; there MUST NOT be a
single-server-per-machine requirement. Cross-session coordination MUST rely on
the shared graph DB, not on a coordinating process:

1. **Atomic claims.** Before emitting a `dispatch_ticket`, the server MUST claim
   the ticket (and a slot) under an immediate transaction, so two servers MUST
   NOT be able to hand the same node to their sessions.
2. **Machine-wide compute cap.** The slot ledger (§2.6) enforces the global
   parallelism limit across all sessions and servers.
3. **Liveness.** Each server MUST register itself in the DB on spawn (session id,
   pid, start time) and heartbeat while its orchestrator session is alive; the
   server dies with the session, so a crashed orchestrator's claims go stale and any
   other server MAY reclaim them via the registry. In channel mode workers are
   event-driven and dormant between events, so there is no per-worker progress
   heartbeat; §2.6's per-owner heartbeats apply only where workers run continuously
   (polling mode). Detecting an orchestrator whose process lives while its agent loop
   wedges is out of scope for the registry.
4. **Split reclamation.** Reclaiming a claim clears it in the DB, which any server
   MAY do. The tracker-side unpark (clearing §2.6's mirrored working label) is a
   tracker write the server cannot make, so it MUST be left to the coordinator
   subagent of the next `dispatch_ticket` to reconcile.

## Fallback mode

When the channel capability is unavailable, skills MUST fall back to their
foreground polling behavior (`polling` mode). The server MUST report capability
refusal at startup so the mode selection is deterministic. Mode selection MUST NOT
change a skill's judgment content — only whether it waits by yielding for events
or by looping itself.

## Lifecycle

### Start

The server starts when the session runner spawns it. On startup it MUST:

1. Verify the required CLIs are present and authenticated (`git`, `gh`, the CI
   provider CLI). A missing or unauthenticated required CLI is a fatal server
   error.
2. Establish the channel capability. If the runner refuses it, the server MUST
   signal fallback mode rather than aborting the session.
3. Rebuild its watch set from the graph DB (the spawning session's open claims
   and un-merged PRs) and begin watching.

### Stop

The server stops when its session ends; it MUST exit cleanly with the session.
There is no separate stop command and no in-flight runner to terminate — the
session is the runner.

### Distribution

The server ships as part of the `dispatch` CLI (no separate binary). Its channel
mode is entered via `dispatch mcp` and is registered with the runner like any MCP
server (plugin `.mcp.json` / `--channels`).
