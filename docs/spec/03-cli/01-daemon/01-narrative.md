# §3.1.1 — Daemon: Narrative

## Why a daemon

A single agent session is interactive: a human starts it, it does work, and it
exits. Real engineering work doesn't fit in one session. CI takes minutes;
reviewers take hours; tickets sit between humans for days. The protocols require
the agent to monitor PRs and tickets across those gaps — but nothing in the
protocols keeps a process alive between events.

The daemon fills that gap. It runs in the background, subscribes to the event
sources the protocols read from, and resumes the appropriate agent session when
an event arrives. The session does its work per the protocols, exits, and the
daemon goes back to waiting — with the session ID preserved so the next event
resumes the same conversation rather than starting cold.

## Process model

The daemon is a single long-running process, one per machine. All repositories
and agent sessions share it. The unit of persistent state is a **task** — one PR
or one ticket the daemon is monitoring. Tasks live in the state directory between
events.

An agent session is logically long-lived (one session per task) but physically
transient: the runner process exits when an event handler completes. The daemon
reattaches to the same session ID on the next event to maintain conversation
context. This means the agent never "loses" what it was doing — its history stays
in the runner, keyed by session ID.

## Event system

The daemon reacts to events from three sources: GitHub (PR comments, reviews,
check runs, state changes), the configured ticket tracker (Linear, GitHub Issues,
etc.), and the CI provider (Buildkite, or GitHub Actions via the GitHub source).

For each source, the daemon picks the least expensive strategy that works:

1. **SDK watch / streaming API** — held in-process; no subprocess needed.
2. **Watch subprocess** — a CLI in `--watch` mode; the daemon monitors its output.
3. **Polling** — last resort, with a dynamic interval that adjusts per lifecycle
   stage (tighter near known transition points, looser when nothing is expected).

Multiple changes discovered on the same polling tick — say, a Copilot review and
a CI failure — are combined into a single coalesced event and delivered to the
agent once. This avoids the agent receiving a cascade of single-event invocations
when it only needs to know about the current state of the PR.

When a change arrives while the agent is already running, the daemon doesn't
interrupt it. Instead, it accumulates the incoming changes into a pending
follow-up record. When the current invocation exits, the daemon immediately
spawns the follow-up with everything that arrived. For session-invalidating events
(PR closure, force-push), the daemon may preempt the running session rather than
waiting.

## Prompt system

Each event kind has a corresponding prompt template. The daemon resolves templates
in this order, taking the first match:

1. Per-repo override: `<repo>/.dispatch/prompts/<event>.{xml,md}`
2. Per-user override: `~/.config/dispatch/prompts/<event>.{xml,md}`
3. Built-in default bundled with the daemon binary

This layering lets a project customize how its agents respond to a specific event
without touching the defaults for everything else. A user can apply their own
preferences across all repos they work in. And a fresh install works with zero
configuration — the defaults cover all event kinds.

Both XML and Markdown template formats are supported. XML is preferred for new
templates (it more clearly delimits data from instruction); Markdown is accepted
for parity with existing work. Templates support mustache-style placeholders
(`{{event.author}}`).

## Relationship to §2.4

§2.4 (Delivery Protocol) describes what an agent session is required to do when
changing code: worktree setup, PR-open sequence, pre-push review, reviewer
progression, monitoring, and termination. §3.1 (this section) describes the
orchestration layer above that.

The split works like this:

- **The daemon handles**: worktree creation, task lifecycle on disk, event
  routing to the right session, concurrency limits, crash recovery, and heartbeat
  firing. When a new task arrives, the daemon creates the worktree before spawning
  any runner — the runner is never responsible for worktree creation.

- **The agent session handles**: actual code changes, pre-push review, PR body
  and plan comment content, reviewer responses, and actionability judgments.

§2.4 reads as the contract an agent session must honor regardless of what invoked
it (interactive or daemon-driven). §3.1 reads as the contract the daemon must
honor to reliably deliver events to those sessions. The daemon doesn't replace
§2.4's requirements; it provides the infrastructure that makes them feasible
across long-running work.

## Crash recovery

If the daemon crashes mid-run, it picks up where it left off. On restart:

- Tasks are rehydrated from disk.
- Events queued in the event spool are replayed oldest-first.
- Any task that had a live runner at crash time is treated as interrupted: the
  daemon synthesizes a `daemon-restart` event and immediately re-spawns the
  runner for that task.

The invariant is that in-flight work is never silently abandoned. If the daemon
crashes in the middle of an agent acting on a PR review, the next start resumes
the same session with context about what was interrupted.
