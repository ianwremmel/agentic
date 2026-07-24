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
onward — a coordinator subagent per `dispatch_ticket`, and, for each PR/CI trigger
(matched by `repo`/`pr`), the subagent handling that PR. Only an agent's own spawner
holds the id needed to re-address it, so where the handling subagent was spawned by a
coordinator rather than by the orchestrator, the relay MUST pass through that
coordinator. A subagent MAY be **resumable** — it returns after each event, and its
spawner re-addresses it by the id it received at spawn, with the earlier turns still
in context — or short-lived, spawned per event. A resumable subagent holds no process
between events, so its spawner MUST NOT treat it as live. Either way the graph DB and
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

The server MUST NOT keep durable state of its own beyond the graph DB. A restart
mints a new registry id and inherits nothing from the dead server, so the new one
MUST rebuild its watch set from the open claims and un-merged PRs it can reach
from the working directory it was spawned in; claims the dead server held return
to the frontier through stale reclamation rather than being adopted.

### Mode marker

The server MUST make its presence detectable so skills can select channel vs
fallback mode. A channel subprocess cannot set an environment variable in the
agent's process, and the runner gives no signal when it refuses the capability —
a refused server sees an ordinary MCP handshake and its pushes are dropped
silently. Detection MUST therefore be a positive acknowledgement:

1. The server pushes a `probe` event carrying the registry id it minted (see
   [Multi-session](#multi-session)), instructing the session to record the
   acknowledgement against that id through `dispatch mcp ack` (§3.2).
2. `dispatch mcp status` MUST report channel mode active only when an
   acknowledgement exists for the caller's own live server
   ([Correlating a caller to its server](#correlating-a-caller-to-its-server)),
   and `inactive` otherwise. This is what makes a skill running in a session
   whose channel was refused select `polling`.
3. Until the acknowledgement lands the server MUST keep re-pushing the probe
   rather than latch a verdict after a fixed timeout, on a capped backoff so an
   unanswered probe does not consume a turn on every tick forever. A session that
   is merely busy, or that has not yet loaded a skill that answers, then converges
   on channel mode when it can, and a session whose runner refuses the capability
   never leaves `polling`.

The server MUST begin watching without waiting for the acknowledgement, so a
session that ends up in `polling` costs nothing but the probes. It MUST NOT emit
a work order before the acknowledgement lands: a work order claims a ticket and a
slot, which a refused session would never release while its live server keeps the
claim fresh.

### Correlating a caller to its server

`dispatch mcp status` answers for the caller's own session, and several sessions
— each with its own server — can be live on one machine. The MCP handshake
carries no session identity, but the runner does inject one, as
`CLAUDE_CODE_SESSION_ID`, into the environment of the processes it spawns: the
channel server and the commands the session runs alike. That is the correlator.

1. **Record.** The server MUST read the session id from its own environment at
   spawn and store it on its registry row. A server whose environment carries
   none MUST register without one. A row without one MUST NOT match any caller;
   it can be addressed only by `dispatch mcp ack`, which repairs it by writing
   the acking session's id, or by an explicit `--server` from a caller that has
   no session id of its own — an operator at a terminal. A caller that has one
   MUST NOT be answered from a row that does not carry it.
2. **Refresh.** `dispatch mcp ack` (§3.2) MUST write the acking process's session
   id onto the row it acknowledges, replacing what the server recorded. The ack
   is the only write that runs in a session shell at a moment when the server it
   answers is already known, so it is the one point where the two can be made to
   agree. Without it a server that outlives the session id it was spawned under
   keeps claiming tickets and slots — its heartbeat holding them fresh — while
   every later caller fails to correlate and drops to `polling`.
3. **Match.** A command that needs a server and was given no `--server` MUST read
   the session id from its own environment and take the live registry row
   carrying the same id. A row is **live** when a process with its registered pid
   **and start time** still exists and its last heartbeat is within §2.6's
   staleness threshold — the pid check is what rules out a server that crashed
   under a session still running, and comparing start time is what stops a reused
   pid resolving.
4. **Fail closed.** Where the match does not yield exactly one live acked server,
   `dispatch mcp status` MUST report `inactive` and MUST name which condition it
   hit: `no-session-id` (the environment carries none), `no-server-for-session`
   (no live row carries it), `ambiguous-session` (more than one live row does),
   or `awaiting-ack` (a live row carries it but its probe is unanswered). Only
   `awaiting-ack` is a state a session converges out of; the rest are broken, and
   an operator needs them apart. `status` MUST NOT fall back to a weaker handle —
   not the working directory, which two sessions can share, and not "the only
   live server", which holds until a second session exists. Naming another
   session's server active strands a skill yielding for events that will never
   reach it; an unnecessary `inactive` costs only polling.

Two live rows under one session id are possible — a runner can be told to reuse a
session id — so `ambiguous-session` is a real state and MUST NOT be resolved by
preferring the newer row. A server that crashed leaves a row that is not live, so
a respawn inside one session does not reach this case.

The acknowledgement is keyed by the **registry id**, never by the session id, and
MUST NOT outlive the row it acknowledges: a new server for the same session
starts unacked and re-runs the handshake, so an inherited or resumed session id
cannot carry an old server's acknowledgement onto a channel that was never
proven.

Subagent commands inherit their session's id, so they correlate to that session's
server — the one whose events the orchestrator relays to them (see
[Orchestrator session and routed subagents](#orchestrator-session-and-routed-subagents)
for what a subagent does with them; `active` there means the spawner will
re-address it, not that events arrive at the subagent directly). A runner started
from inside another session's tool call exports its own id to its children, so a
nested session resolves to its own server or to none.

`--server <registry-id>` remains available and MUST take precedence over the
match. Where the caller has a session id of its own and it differs from the named
row's, the command MUST report `inactive` with `no-server-for-session` rather
than answer for another session's server.

The variable is the runner's, not this spec's, so it can change. Its removal
fails closed: every caller drops to `polling`, uniformly, with `no-session-id`
naming the cause. What the rule cannot survive is a runner that exports an
*inherited* id to a nested session, which would put a nested session and its
parent on one id; the measured behavior is that each runner exports its own.

## Channel message protocol

### Notification format

Each event is a `notifications/claude/channel` notification with `content` (the
tag body, a string) and `meta` (a string→string map rendered as tag attributes).
Every event MUST carry:

| Attribute | Source        | Meaning                                                                                        |
| --------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `source`  | set by runner | The runner's name for the server — `plugin:dispatch:mcp`, not `dispatch`. The server MUST NOT set it. |
| `kind`    | `meta`        | The event kind (tables below).                                                                 |
| `seq`     | `meta`        | Monotonic per-server sequence number for ordering/coalescing.                                  |

The channel layer does not dedupe attributes: a `source` key in `meta` emits a
second `source` attribute on the tag rather than overriding the runner's. The
server MUST NOT set one.

Additional `meta` keys are per-kind. Each key MUST match an anchored
`^[a-zA-Z_][a-zA-Z0-9_]*$`; the channel layer drops any key that does not (`pr`,
never `pr-number`). Values MUST be strings — a non-string value fails the
runner's schema validation and costs the whole event, so the server MUST
stringify before pushing.

Bodies MUST NOT be assembled from raw external text. A PR/CI event body MUST be
the `dispatch pr-status` payload for the referenced PR; a work-order or `probe`
body MUST be a short instruction naming the work. This keeps the injected content
identical to what the session already reads through the CLI. The runner rewrites a `</channel>`
in a body so it cannot close the tag early, but it does not strip a `<channel …>`
opener; the server MUST NOT rely on that rewriting in place of the rule above.

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
performs the part that needs a tracker write or an operator message.

**Handshake** — one kind, outside both families, carrying no graph work.

| kind    | `meta` (beyond source/kind/seq) | asks the session to                                                |
| ------- | ------------------------------- | ------------------------------------------------------------------ |
| `probe` | `server` = the registry id      | run `dispatch mcp ack --server <id>`, establishing the mode marker |

New event kinds MAY be added. Renaming an existing kind is a breaking change.

### Ordering and coalescing

`seq` MUST increase monotonically per server. Changes of the **same kind on the
same PR** observed on one tick MUST be coalesced into a single event; changes that
differ in kind or PR MUST remain distinct events, since one event's
`kind`/`repo`/`pr` are single-valued and merging heterogeneous changes would lose
information. Events queued while the session is busy are delivered once it is
free, each as its own turn, in `seq` order — the channel layer never merges two
events, so all coalescing is the server's. The session MUST handle each event and,
where an event may be stale by delivery time, re-read canonical state through the
corresponding `dispatch` command rather than acting on the body alone.

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
3. **Liveness.** Each server MUST mint its own registry id on spawn — the runner
   supplies no registry id — and register itself in the DB under it: registry id,
   pid, start time, the session id from its environment, the acknowledgement
   state, and the last heartbeat (see
   [Correlating a caller to its server](#correlating-a-caller-to-its-server)).
   It MUST then heartbeat while its orchestrator session is alive; the
   server dies with the session, so a crashed orchestrator's claims go stale and any
   other server MAY reclaim them via the registry. In channel mode workers are
   event-driven and have returned between events, so there is no per-worker progress
   heartbeat; §2.6's per-owner heartbeats apply only where workers run continuously
   (polling mode). Detecting an orchestrator whose process lives while its agent loop
   wedges is out of scope for the registry.
4. **Split reclamation.** Reclaiming a claim clears it in the DB, which any server
   MAY do. The tracker-side unpark (clearing §2.6's mirrored working label) is a
   tracker write the server cannot make, so it MUST be left to the coordinator
   subagent of the next `dispatch_ticket` to reconcile.

## Fallback mode

When the channel capability is unavailable, skills MUST fall back to their
foreground polling behavior (`polling` mode). Because refusal is invisible to the
server, the mode is decided by the acknowledgement handshake in
[Mode marker](#mode-marker) — no acknowledgement yet means `polling`, as does a
caller that cannot correlate itself to a live server
([Correlating a caller to its server](#correlating-a-caller-to-its-server)). Mode
selection MUST NOT change a skill's judgment content — only whether it waits by
yielding for events or by looping itself.

## Lifecycle

### Start

The server starts when the session runner spawns it. On startup it MUST:

1. Register itself in the graph DB, recording the session id from its own
   environment
   ([Correlating a caller to its server](#correlating-a-caller-to-its-server)),
   and retire — delete — any row carrying that session id that is no longer
   live, which bounds the registry rather than changing any match, since a row
   that is not live never matched. It MUST NOT retire a live row: two live
   servers under one session id are the `ambiguous-session` case, which fails
   closed rather than being resolved by whichever server registered last. It
   MUST read the variable before any re-exec or privilege change that would
   replace its environment. Registration comes first because it needs only the
   DB, and a skill invoked on the session's first turn would otherwise correlate
   to nothing.
2. Verify the required CLIs are present and authenticated (`git`, `gh`, the CI
   provider CLI). A missing or unauthenticated required CLI is a fatal server
   error; the server MUST retire its row before exiting.
3. Rebuild its watch set from the graph DB and begin watching.
4. Start the acknowledgement handshake, concurrently with step 3. The server MUST
   NOT abort the session over an unanswered probe, and MUST NOT emit a work order
   until one is answered.

### Stop

The server stops when its session ends; it MUST exit cleanly with the session.
There is no separate stop command and no in-flight runner to terminate — the
session is the runner.

Exiting with the session is what keeps `ambiguous-session` recoverable, so it
MUST NOT depend on the runner signalling: the server MUST exit when its stdio
peer closes or the process that spawned it is gone. A server that kept
heartbeating after its session ended would hold that session id live, and a
later session told to reuse the id would then find two live rows and never leave
`polling`. For the same reason a server that finds its own row retired MUST exit
rather than re-register or keep beating.

### Distribution

The server ships as part of the `dispatch` CLI (no separate binary). Its channel
mode is entered via `dispatch mcp`. Registration takes three parts: the MCP
server declaration (plugin `.mcp.json`), an entry naming it in the session's
channel list, and that entry clearing the channel allowlist. Entries are spelled
`plugin:<name>@<marketplace>` or `server:<name>` — a bare name is rejected — and
reach the session either through `--channels <entry>` or, for local development,
`--dangerously-load-development-channels <entry>`. The declaration alone connects
the server but registers no channel, and a named entry that clears no allowlist
route registers none either.
