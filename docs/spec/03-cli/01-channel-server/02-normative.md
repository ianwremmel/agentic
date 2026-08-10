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
restart), and in channel mode the waiting MUST stay in the server — a subagent
MUST NOT run a foreground poll loop. ([Fallback mode](#fallback-mode), where no
channel delivers, is the one place skills loop for themselves.)

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
a work order before the acknowledgement lands: a work order claims a ticket,
which a refused session would never release while its live server keeps the
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
   keeps claiming tickets — its heartbeat holding them fresh — while
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

| Attribute | Source        | Meaning                                                                                               |
| --------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `source`  | set by runner | The runner's name for the server — `plugin:dispatch:mcp`, not `dispatch`. The server MUST NOT set it. |
| `kind`    | `meta`        | The event kind (tables below).                                                                        |
| `seq`     | `meta`        | Monotonic per-server sequence number for ordering/coalescing.                                         |

The channel layer does not dedupe attributes: a `source` key in `meta` emits a
second `source` attribute on the tag rather than overriding the runner's. The
server MUST NOT set one.

Additional `meta` keys are per-kind. Each key MUST match an anchored
`^[a-zA-Z_][a-zA-Z0-9_]*$`; the channel layer drops any key that does not (`pr`,
never `pr-number`). Values MUST be strings — a non-string value fails the
runner's schema validation and costs the whole event, so the server MUST
stringify before pushing.

Observation events (the PR/CI and graph triggers below) additionally carry
routing keys the pusher stamps at delivery time, after the per-kind meta, so no
event producer can forge them:

| Attribute    | Meaning                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `item`       | The graph node the event belongs to.                                                               |
| `repo`, `pr` | The node's registered PR, when it has one.                                                         |
| `agent`      | The recorded address of the worker on the node (`dispatch worker set`), when this session has one. |

`agent` names a **resumable** worker — one that has returned and holds no
process, but whose spawner can re-invoke it by that address with its context
intact. The recording session is the only one that can, so the delivering
server stamps `agent` only from its own session's worker table; an event
delivered by another session carries none, and that session treats it as
informational.

A coalesced event (see [Ordering and coalescing](#ordering-and-coalescing))
also carries `changed` — every kind that fired on the tick, comma-joined. It is
written by the server's coalescer, not the delivery stamp, and is present only
when more than one kind fired; its absence means the `kind` is the whole story.

`agent` is what lets the orchestrator relay the event to the worker already
holding the item instead of cold-starting a resume pass; an event without one
names no reachable worker, and the session dispatches accordingly.

Bodies MUST NOT be assembled from raw external text, and MUST NOT cost a
per-event subprocess: the server renders a PR/CI event body itself from its
stored snapshot for the PR — the latest state its poll recorded, at least as
new as the change the event reports. The event is the wake signal and the body
the freshest stored state, not a transcript of the moment the change was
observed; a worker that needs canonical current state re-reads it. The
rendering uses the XML vocabulary the worker already reads from `dispatch
pr-status`, and names `pr-status` as the deep read to run for actionability
classification and cached comment bodies. Where no snapshot is stored, the
body MUST say so and instruct the worker to run `pr-status` itself. A
`ticket_changed` body MUST instruct the session to re-read the ticket through
the tracker adapter — the
graph's copy is what just changed, so no body assembled from it is
authoritative. A work-order or `probe` body MUST be a short instruction naming
the work. The runner rewrites a `</channel>` in a body so it cannot close the
tag early, but it does not strip a `<channel …>` opener; the server MUST NOT
rely on that rewriting in place of the rules above.

### Event catalog

**PR / CI triggers** — body is the server's rendering of its stored snapshot
(see [Notification format](#notification-format)); `repo`/`pr` ride the routing
keys. A change authored by this agent — judged by its machine marker, never by
the account, since shared credentials put the operator and the agent on one
login — MUST NOT fire an event: waking a worker to report its own comment is
the noise that would make server-side waiting worse than the polling it
replaces.

| kind              | `meta` (beyond source/kind/seq and routing keys)                | fires when                                                             |
| ----------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ci_finished`     | `rollup` = `success` \| `failure`; `failing` names the failures | the rollup settles (afresh for a new head), or the failing set changes |
| `pr_review`       | `state` = `approved` \| `changes` \| `comment`, `reviewer`      | a review is submitted                                                  |
| `pr_comment`      | `thread`                                                        | a new top-level comment or unresolved inline reply lands               |
| `pr_state_change` | `state` = `ready` \| `draft` \| `merged` \| `closed`            | the PR changes lifecycle state                                         |
| `pr_conflicted`   | `mergeState`                                                    | the PR stops merging cleanly against its base                          |
| `pr_head_changed` | `head`                                                          | the head commit moves under the watch                                  |

**Graph triggers** — observations the server's own database reveals, delivered
through the same queue as the PR/CI triggers, with the same routing keys.

| kind             | `meta` (beyond source/kind/seq and routing keys) | fires when                                                          |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `ticket_changed` | `ticket`, `from`, `to`                           | a tracker write (`dispatch ticket set`) reveals a status transition |
| `watch_expired`  | —                                                | a watch reaches its deadline with no diff to report                 |

A watch's deadline MUST be measured from when the wait was armed. A poll that
extends it is one a quiet PR never reaches, and the quiet PR — no CI moving,
no reviewer requested — is the only kind the deadline exists for. Firing MUST
emit the `watch_expired` event: a fired watch is no longer polled and a live
worker holding the item keeps it out of the queue, so a silent fire would move
the item from watched to unreachable.

A `ticket_changed` row is written without a session, so any acked live server
MAY deliver it. So MAY any server deliver a row whose session no longer exists:
the worker it named died with the session, and a row held for a session that
cannot return is a notice nobody ever reads.

For every observation event the delivery mark MUST be a conditional claim taken
as the last write before the push, so no event is ever delivered twice; the
residual is a push that throws after the claim — a dying server — which loses
that delivery rather than repeating it.

**Ingest instructions** — the server delegates tracker reads it cannot make
itself (§Work the server cannot do itself). Body is a short instruction naming
the flat write commands to use.

| kind               | `meta` (beyond source/kind/seq) | asks the session to                                  |
| ------------------ | ------------------------------- | ---------------------------------------------------- |
| `scan_project`     | `tracker`, `projects`, `cursor` | scan every ticket in those projects since the cursor |
| `fetch_ticket`     | `tracker`, `ticket`             | fetch that one ticket (or report it `missing`)       |
| `refresh_ticket`   | `tracker`, `ticket`             | re-fetch one watched ticket (or report it `missing`) |
| `refresh_complete` | `tracker`                       | stop fetching; the graph is complete                 |

`refresh_ticket` is how the server owns the *when* of ticket re-reads it cannot
make itself: it MUST schedule one for each ticket whose tracker state can move
under the graph — in-flight and parked statuses, not backlog or terminal ones,
which the scan covers — on a cadence derived from the ticket's status. At most
one ask per ticket is open at a time, and an ask that goes unanswered past a
staleness window MUST be re-delivered rather than assumed to have arrived. The
answering `dispatch ticket set` is the completion signal; a status transition
that write reveals is pushed back as a `ticket_changed` event.

**Work orders** — body is a short instruction naming the work: for the
dispatch and review kinds, the agent to launch; for the rest, the tracker
write or operator message to make. The server MUST do the graph reasoning
(rank, gate, admit, and — for the dispatch kinds — claim) before emitting one;
the session executes it and MUST NOT need to read the graph.

| kind                       | `meta` (beyond source/kind/seq) | asks the session to                                                                                  |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `dispatch_ticket`          | `project`, `ticket`, `pass`     | launch a ticket-worker to coordinate the ticket (already claimed)                                    |
| `dispatch_pr`              | `pr`, `pass`, `ticket`          | launch a pr-worker to implement the PR item (already claimed); `ticket` only on a ticket-backed item |
| `perform_milestone_review` | `project`, `milestone`          | launch a milestone-reviewer; the milestone is claimed                                                |
| `park_human_blocked`       | `project`, `ticket`             | move a human-blocked ticket to its parked state and post the handoff (a tracker write)               |
| `alert_failure`            | see below                       | alert the operator about a node that cannot proceed without them                                     |
| `project_complete`         | `project`                       | record and announce that the project's work is done                                                  |

`alert_failure` covers two node shapes, distinguished by its meta: a ticket
that failed unrecoverably carries `project` and `ticket`; a PR item carries
`pr` (the item id) and, when ticket-backed, `ticket`. A PR item fires it for
an unrecoverable failure and also for a `human-blocked` outcome — a PR item
has no tracker status to park, so the alert is the only way the operator hears
the question its worker left. Removing the outcome requeues the item.

The last three carry the scheduler tick's non-scheduling duties in §2.6: the
server detects the condition deterministically from the graph, fires each once
per episode, and the session performs the part that needs a tracker write or an
operator message.

**Handshake** — one kind, outside both families, carrying no graph work.

| kind    | `meta` (beyond source/kind/seq) | asks the session to                                                |
| ------- | ------------------------------- | ------------------------------------------------------------------ |
| `probe` | `server` = the registry id      | run `dispatch mcp ack --server <id>`, establishing the mode marker |

New event kinds MAY be added. Renaming an existing kind is a breaking change.

### Ordering and coalescing

`seq` MUST increase monotonically per server. Everything one tick observed
about **one PR** MUST be coalesced into a single event — one event per PR per
tick. Delivering one event per change would interrupt a worker mid-reaction: it
is told CI failed, starts fixing, and is then told a reviewer replied, which it
must handle as a second turn without the first one's context. The worker
already reads one status payload per wake and reacts to everything in it at
once; the channel MUST NOT be worse than that. In the coalesced event the
`kind` is a routing hint — the most significant change that fired, by the fixed
priority `pr_state_change` > `pr_conflicted` > `ci_finished` > `pr_review` >
`pr_head_changed` > `pr_comment` — the `changed` key lists every kind that
fired (when more than one did), the per-kind meta of all of them rides along
(the lead kind's keys winning a collision), and the body carries the whole
state. Changes on different PRs MUST remain distinct events.

One exception: a terminal lifecycle transition — the PR merged or closed — is
reported alone, whatever else the tick saw. Once the PR has left its live
state, same-tick CI, review, and comment changes are noise a closing-out
worker would only have to ignore.

Events queued while the session is busy are delivered once it is free, each as
its own turn, in `seq` order — the channel layer never merges two events, so
all coalescing is the server's. The session MUST handle each event and, where
an event may be stale by delivery time, re-read canonical state through the
corresponding `dispatch` command rather than acting on the body alone.

### Work the server cannot do itself

For any source the server cannot reach without an MCP client (a tracker exposed
only over MCP), the server MUST NOT attempt the fetch itself. It MUST delegate
through the ingest instructions above, driven by the per-tracker refresh state
machine: `dispatch refresh` opens a scan and queues `scan_project`; a
placeholder id queues `fetch_ticket`; the resulting flat-command writes are the
completion signal. Every instruction is a durable queue row with a delivery
mark, so a restarted server re-delivers what was never answered rather than
assuming a pushed instruction arrived.

## Event-source orchestration

For each event source the server MUST use the least-expensive available strategy:

1. SDK watch / streaming API (preferred).
2. Watch subprocess (e.g. a `--watch`-mode CLI).
3. Polling (fallback).

| Source              | Default strategy                                                |
| ------------------- | --------------------------------------------------------------- |
| GitHub PR / issue   | Polling; dynamic cadence per stage                              |
| GitHub check rollup | `gh pr checks --watch` subprocess per watched PR with active CI |
| Buildkite build     | `bk build wait` subprocess                                      |
| Graph DB            | SQLite read on the poll tick                                    |

Dynamic polling intervals:

| Stage                         | Default interval      |
| ----------------------------- | --------------------- |
| Awaiting Copilot review       | 30 s                  |
| Awaiting CI on an active head | 60 s once, then 5 min |
| Awaiting human reviewer       | 5 min                 |
| Awaiting ticket transition    | 5 min                 |
| Idle (monitoring only)        | 15 min                |

The server SHOULD tighten the interval near known high-likelihood transition
points. Intervals MUST be data-driven, not constant. A watch subprocess or SDK
handle that fails MUST be restarted with capped backoff (2s, 4s, 8s, cap 60s);
the server MUST NOT silently downgrade to polling on repeated failure.

## Multi-session

Each participating session MUST run its own server; there MUST NOT be a
single-server-per-machine requirement. Cross-session coordination MUST rely on
the shared graph DB, not on a coordinating process:

1. **Atomic claims.** Before emitting a `dispatch_ticket`, the server MUST claim
   the ticket under an immediate transaction, so two servers MUST NOT be able
   to hand the same node to their sessions.
2. **Machine-wide compute cap.** The live-claim count (§2.6) enforces the
   global parallelism limit across all sessions and servers.
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

Registration is necessary, not sufficient: delivery is gated by three
runner-side opt-ins — the channel-list entry above plus two others — and every
one of them fails silently, the server seeing an ordinary MCP handshake while
its pushes are dropped:

1. The channel-list entry (`--channels` or, for an un-allowlisted plugin,
   `--dangerously-load-development-channels plugin:<name>@<marketplace>`).
2. `channelsEnabled: true` in the runner's managed settings.
3. The operator answering the runner's full-screen channel confirmation dialog.

No API reports which of the three is missing. This silence is why the mode
marker is a positive acknowledgement handshake rather than any inspection of
the runner: the only proof a channel delivers is an event that came back.
