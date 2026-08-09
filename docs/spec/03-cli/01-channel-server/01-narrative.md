# §3.1.1 — Channel Server: Narrative

The channel server keeps engineering work alive across the gaps where CI runs,
reviewers think, and tickets sit between people. It is the `dispatch` CLI running
as a **Claude Code channel** attached to a live session: it watches the event
sources it can reach and pushes events into that session so the agent reacts
without sitting in a loop.

## Why a channel server

A single agent session is interactive, but the waiting around it is not the
agent's job. CI takes minutes; reviewers take hours; tickets sit for days. The
protocols require an agent to monitor PRs and tickets across those gaps, and
today the skills do it by sitting in foreground `sleep` loops — burning a turn
and context to watch for a change that may be seconds or hours away.

Waiting is deterministic infrastructure; reacting is judgment. This spec's
governing rule is that determinism belongs in the CLI. The channel server is
where the waiting moves. It watches the event sources it can reach, and when
something worth reacting to happens, it pushes an event into the session that is
already open and already holds the context. The session reacts once and yields;
the server goes back to watching.

## Process model

The channel server is **one process per session**. It is an MCP server that the
session runner (Claude Code) spawns as a stdio subprocess when the session starts
and that exits when the session ends — a session's server lives exactly as long
as the session it serves, and nothing starts or stops it out of band.

The server is **push-only**. It emits channel notifications; it does not require
the session to call server-side tools for correctness. Everything the session
needs to tell the server — which PR to watch, that a delegation is handled, that
work is claimed — it says by running ordinary `dispatch` commands that write the
**shared graph database** (§2.6). The server reads that same database on its
tick. So the graph DB is the backbone in both directions: the server watches it
and pushes; the session writes it and is watched. No second control channel
exists to keep consistent.

The server holds no durable state of its own. All durable state lives in the
graph DB and on the platforms. On restart the server rebuilds its watch set from
the DB — this session's open claims and un-merged PRs — and resumes.

## Event system

The server reacts to changes in the sources it can reach without an MCP client:
GitHub (PR comments, reviews, state changes) and the CI provider directly, and
its own graph DB. For each source it picks the least-expensive strategy that
works — an SDK/streaming watch, a watch subprocess, or polling with a dynamic
interval — and coalesces everything one tick saw about one PR into a single
event, so a worker wakes once and reacts to all of it (changes on different PRs
stay distinct, ordered events; a terminal merge or close stands alone, since
nothing else about a finished PR still matters).

Three families of event reach the session. **Triggers** report a change on
something watched — a PR, or a ticket whose tracker write revealed a status
move. A PR trigger's body is the server's own rendering of the snapshot it
already polled — the same vocabulary the session reads through the PR-status
reader, without a subprocess per event — or, before any snapshot is stored, an
instruction to fetch the state itself. Either way the session applies its own
judgment: deciding what a review or a failing check demands is not
deterministic. **Work orders** are the opposite: the CLI does the deterministic
graph reasoning itself — ranking the frontier, applying milestone gates,
accounting for capacity, claiming — and tells the session exactly what to do next
(coordinate this ticket, review this milestone). The session
runs the named skill and never has to read or understand the graph. **Fetch
instructions**, the third family, delegate the reads the server cannot make —
next paragraph.

One source the server **cannot** reach is a tracker exposed only over MCP (Linear
today). A channel is an MCP server, not a client; it cannot call another MCP
server. So a tracker refresh is delegated: the server pushes fetch
instructions (`scan_project`, `fetch_ticket`, and `refresh_ticket` for
in-flight and parked tickets whose tracker state can move under the graph) and the session
— which holds the MCP client and the tracker adapter skill — fetches and writes
the delta back through the flat `dispatch` write commands, which the server
observes. A status transition one of those writes reveals comes back to the
session as a `ticket_changed` event, so the server owns the *when* of every
re-read and the session only ever answers. The trust boundary the rest of the spec relies on (MCP access
stays in the session) is preserved, and the server drives the refresh instead of
a skill self-timing it.

## Channel mode vs fallback mode

Channels are not universally available: they are a research-preview capability,
require Anthropic authentication, and can be disabled by organization policy.
Session kind matters too. An un-allowlisted plugin registers only in an
interactive session, because the development-channel flag it depends on takes
effect nowhere else, so until the plugin is allowlisted the server needs a
terminal. Once it is allowlisted an interactive or background session both host
it; a print session registers it too but exits when its prompt is answered, so it
never outlives the work that started it. A runner that declines any of this drops
the server's events without telling it, so the server learns its own mode from
whether the session acknowledges a startup probe. The skills therefore keep their
existing foreground-loop behavior as a **fallback mode** and select between the
two the way they already select other
behavior variants (team vs solo) — by dynamically loading a mode variant. In
channel mode a skill returns after each unit of work and is re-entered per
event; in polling mode it runs the loop itself. The judgment content is
identical across modes; only the waiting differs, so the two modes cannot drift
into two different behaviors.

Which server a skill is asking about is a separate question, and every skill but
the one answering a probe has to answer it — only the probe carries a server id,
and several sessions run their own servers on one machine. The handshake carries no
session identity, but the runner puts one in the environment of the server and of
the commands the session runs, so the server records it and a cold skill reads
its own. Where that match is not exact the answer is no channel, because a skill
told it has one when it does not waits for events that never come.

## Multi-session

Channel events reach only a top-level session, and a subagent can't be woken
directly, so a project runs as one orchestrator session that owns the server and
routes events down to subagents (a coordinator per ticket, and deliver for a PR
event, reached through whichever agent spawned it) — no per-ticket sessions to
launch. The CLI has long supported several such
sessions on different projects at once; each owns a server watching its own
tickets' PRs, all sharing the one graph DB. Overlap is prevented in the DB: the CLI
claims a ticket atomically before dispatching a coordinator, so two
orchestrators can't take the same ticket, and the claim count enforces the
machine-wide cap. A server heartbeats while its session is alive, so a crashed
orchestrator's claims go stale and another server reclaims them; event-driven
subagents have returned between events, so there is no per-worker
heartbeat, and a wedged-but-alive orchestrator is a residual case for a watchdog,
not the DB. Clearing a reclaimed claim is a DB write any server can do; the
tracker-side unpark is left to the next dispatch's coordinator to reconcile.

## Relationship to §2.4

§2.4 (Delivery Protocol) describes what an agent session must do when changing
code: worktree setup, the PR-open sequence, pre-push review, reviewer
progression, monitoring, and termination. §3.1 (this section) describes the
layer that keeps such a session fed with events across time.

§2.4 reads as the contract a session honors regardless of what invoked it. §3.1
reads as the contract the channel server honors to reliably deliver events to
that session. The server does not replace §2.4's requirements; it provides the
waiting infrastructure that makes them feasible across long-running work, without
the session having to sit in a loop to get it.
