# §3.1.1 — Channel Server: Narrative

This section supersedes the earlier daemon model. The problem is unchanged —
keeping engineering work alive across the gaps where CI runs, reviewers think,
and tickets sit between people — but the mechanism is different: instead of a
single machine-wide process that cold-spawns a fresh agent per event, the CLI
runs as a **Claude Code channel** attached to a live session and pushes events
into it.

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

The channel server is **one process per session**, not one per machine. It is an
MCP server that the session runner (Claude Code) spawns as a stdio subprocess
when the session starts and that exits when the session ends. There is no PID
lock, no singleton, and no daemon to start or stop out of band: a session's
server lives exactly as long as the session it serves.

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
its own graph DB (frontier changes, milestone gates, freed slots). For each
source it picks the least-expensive strategy that works — an SDK/streaming watch,
a watch subprocess, or polling with a dynamic interval — and coalesces changes
seen on the same tick into a single event.

Events are **triggers, not payloads to be trusted in isolation**. Whatever an
event says, the session responds by running the `dispatch` command that reads
the canonical state and acting on that. Because the PR-status reader is part of
the CLI, a PR event can carry exactly that reader's output as its body: the same
bytes the session would fetch anyway, with no divergence between what the event
said and what the CLI returns.

One source the server **cannot** reach is a tracker exposed only over MCP
(Linear today). A channel is an MCP server, not a client; it cannot call another
MCP server. Rather than engineer around this, the server **delegates**: it pushes
a trigger asking the session — which does hold an MCP client and the tracker
adapter skill — to do the fetch and write the result back through `dispatch
graph`. The server then observes the result in the DB on its next tick. The
trust boundary the rest of the spec relies on (MCP access stays in the session)
is preserved, and the server drives the refresh instead of a skill self-timing
it.

## Channel mode vs fallback mode

Channels are not universally available: they are a research-preview capability,
require Anthropic authentication, and can be disabled by organization policy. The
skills therefore keep their existing foreground-loop behavior as a **fallback
mode** and select between the two the way they already select other behavior
variants (team vs solo) — by dynamically loading a mode variant. In channel mode
a skill yields after each unit of work and is woken by events; in polling mode it
runs the loop itself. The judgment content is identical across modes; only the
waiting differs, so the two modes cannot drift into two different behaviors.

## Multi-session

The CLI supports several sessions working different projects at once, and that
must keep working. It falls out of the process model: each session spawns its
own server, and all servers and sessions share the one graph DB. Overlap is
prevented where it already is — in the DB. Claims are atomic, so two sessions
cannot take the same ticket; the slot ledger enforces the machine-wide compute
cap across every session regardless of which server it belongs to; and stale-
claim recovery reclaims work abandoned by a crashed session. The concurrency cap
and crash recovery that the old daemon centralized are thus provided by the
shared DB, not by a singleton process.

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
