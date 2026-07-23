# Design: the CLI as a channel — pushing events into a live session

This design makes the `dispatch` CLI available over MCP as a **Claude Code
channel**, moves the polling loops out of the skills and into the CLI, and lets
the CLI push events — "refresh the graph", "start ticket X", "CI finished on
PR 7" — back into the session that is doing the work.

It supersedes the cold-spawn daemon model in §3.1. Once accepted, §3.1 is
reframed around the channel server described here (see
[Relationship to §3.1](#relationship-to-31)).

## Motivation

Today every wait is a foreground loop the agent runs itself:

- `deliver` **is** a poll loop — `sleep` + `pr-status` re-reads until a PR
  merges, explicitly forbidding `Monitor` and background loops because the
  armed-monitor wake "observably fails on long polls."
- `orchestrate` ticks once per `/loop` firing, re-reading `dispatch graph
  summary` every 1–30 minutes.
- `work-ticket` and `milestone-review` lazily poll tracker threads and
  heartbeat their claims.

The agent burns a turn — and context — sitting in `sleep`. A review that lands
in ten seconds is noticed on the next five-minute tick. The cadence is guesswork
encoded in skill markdown, per skill, with no shared view of what is actually
worth waking for.

The waiting is deterministic infrastructure; the reacting is judgment. This
repo's rule is that determinism belongs in the CLI. Waiting is determinism the
CLI does not yet own.

## Goals

- The CLI holds the waits. The session is woken only when there is something to
  react to.
- Skills stop containing poll loops. `deliver` and `orchestrate` become **event
  handlers**, not loops.
- The CLI decides cadence once, centrally, with the dynamic intervals §3.1
  already specifies — not scattered across skills.
- Preserve the trust boundary: the CLI never gains an MCP client; the session
  keeps it. MCP-only work is delegated back to the session, not pulled into the
  CLI.
- Keep the session's write path unchanged: the session still acts through the
  existing `dispatch graph …` commands against the shared SQLite graph.

## Non-goals

- Machine-wide, multi-session orchestration (many independent sessions, a
  global concurrency cap, cross-session crash recovery). That was §3.1's
  cold-spawn territory; it is explicitly deferred (see
  [Deferred](#deferred-multi-session-orchestration)).
- Replacing `pr-status` or the `dispatch graph` command surface. They are the
  session's read/write paths and stay as they are.
- A token/REST tracker adapter. The delegation pattern removes the need for one.

## Background: what a channel is, and the one constraint that shapes everything

A [Claude Code channel](https://code.claude.com/docs/en/channels) is an MCP
server that Claude Code spawns as a **stdio subprocess** and that can *push*
events into the running session. The server declares
`capabilities.experimental['claude/channel']: {}` and emits
`notifications/claude/channel` with `{ content, meta }`. The event lands in the
session as a tag:

```text
<channel source="dispatch" kind="ci_finished" repo="o/r" pr="7" state="failure">
CI finished on PR 7: 1 failing check (build). Read pr-status for detail.
</channel>
```

`content` is the tag body; each `meta` key becomes an attribute. Events **queue
and coalesce**: several pushed while the agent is busy arrive together on the
next turn, in order. The server can also expose ordinary MCP **tools** (a
`tools: {}` capability) for the session to call back.

The one constraint that shapes the whole design:

> **A channel is an MCP *server*, not a client.** It can push events and offer
> tools, but it cannot *call* other MCP servers.

So a poll loop living inside the channel server can watch anything reachable
from a plain process — GitHub via `gh`, CI via its provider CLI, git, its own
SQLite graph — but it **cannot** reach a tracker that is only exposed over MCP,
which is exactly how Linear is reached today (`tracker-adapter-linear` drives
the Linear MCP server from inside the skill). This is not a limitation to
engineer around; it is the boundary the design is built on.

### Channel constraints to design within

| Constraint                    | Consequence for this design                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Server, not client (no MCP)   | MCP-only sources are delegated back to the session, never polled in-CLI.           |
| Session-scoped lifetime       | The server lives and dies with one open session; always-on = a persistent session. |
| Research preview              | Flags/protocol may change; custom channels need `--dangerously-load-development-channels` until allowlisted. |
| Anthropic-auth only           | Not available on Bedrock / Vertex / Foundry; org policy (`channelsEnabled`) gates it. |
| Injected, untrusted content   | Event bodies are attacker-influenced (comment authors); push minimal structured events, never raw bodies. |

## The design

### One process: `dispatch serve`

A new long-running CLI mode, `dispatch serve`, speaks the channel protocol over
stdio. It is registered like any MCP server (plugin `.mcp.json` /
`--channels plugin:dispatch@…`). Claude Code spawns it as a subprocess when the
session starts; it exits when the session ends. Inside it runs:

- **The watch loop** — the dynamic-cadence poller over the sources the CLI can
  reach directly (§3.1's interval table, now centralized here).
- **The channel emitter** — turns observed changes into `notifications/claude/channel`
  events, coalescing per tick.
- **A small tool surface** — callbacks the session uses to steer the loop
  (below).

It shares the **same SQLite graph database** the `dispatch graph` commands
already read and write (`$XDG_STATE_HOME/dispatch/graph.db`, WAL,
`busy_timeout`). That shared DB is the backbone of the whole design: the server
watches it, the session writes to it, and neither needs a bespoke channel back
to the other for state.

### Two directions, three message kinds

```
                 push: notifications/claude/channel
   ┌────────────────────────────────────────────────────────┐
   │  1. notify     "CI finished on PR 7"                    │
   │  2. delegate   "refresh graph from tracker"   ─────►    │
   │                                                          ▼
┌───────────────┐                                    ┌─────────────────┐
│ dispatch serve│                                    │  the session    │
│  (watch loop, │  ◄─────────────────────────────    │  (agent + MCP   │
│   shared DB)  │   session acts via dispatch graph  │   client + skills)│
└───────────────┘   commands → same SQLite DB        └─────────────────┘
        ▲                  3. steer (MCP tools)              │
        └────────────────────────────────────────────────────┘
```

**1. Notify (CLI → session).** A structured event about a change the CLI
observed directly. The body is a one-line summary plus routing attributes; the
session pulls detail through its existing deterministic read path (`dispatch
graph doc`, `pr-status <pr>`). Examples: `ci_finished`, `pr_review`,
`pr_state_change`, `ticket_frontier_changed`, `milestone_gate_open`,
`slot_available`.

**2. Delegate (CLI → session).** The move that resolves the MCP boundary. When
the watch loop needs data or an action that only the session's MCP client can
perform, it pushes a delegation event and the session does the work through its
skills, writing results back via `dispatch graph …`. The canonical case:

> The CLI cannot see Linear. On a tracker-refresh interval (or when it suspects
> the graph is stale) it pushes
> `<channel kind="delegate" action="refresh_graph" ...>`. The session runs
> `build-graph` (Linear MCP + `tracker-adapter-linear`), writes tasks / edges /
> milestones through `dispatch graph`, and advances the `linear` cursor. The
> server sees the cursor move and the rows change on its next DB poll — no reply
> needed.

`start ticket X` is the same shape from the other end: the CLI computes the
ready frontier deterministically from the graph DB and pushes
`<channel kind="delegate" action="dispatch_ticket" ticket="CLC-945" ...>`; the
session claims it (`dispatch graph next --claim`) and runs `work-ticket`.

**3. Steer (session → CLI).** A few MCP tools the server exposes so the session
can shape the watch loop directly rather than only through DB state:

| Tool                    | Purpose                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `watch_pr`              | Start/adjust watching a PR (repo, number, lifecycle stage → cadence).       |
| `unwatch_pr`            | Stop watching a merged/closed PR.                                           |
| `ack`                   | Acknowledge a delegation so the CLI stops re-pushing it (idempotency key).  |
| `request_refresh_soon`  | Ask the CLI to tighten the tracker-refresh cadence (a review just landed).  |

The DB-as-backchannel handles most session→CLI signalling for free; these tools
cover the cases where the server needs an explicit poke or an idempotency ack.
Whether `ack` is a tool or just a DB row is an [open question](#open-questions).

### What the CLI watches directly

| Source              | Mechanism (no MCP)                          | Emits                                     |
| ------------------- | ------------------------------------------- | ----------------------------------------- |
| GitHub PR / review  | `gh api` / `gh pr view` (as `pr-status` does today) | `pr_review`, `pr_comment`, `pr_state_change` |
| CI rollup           | `gh pr checks --watch` / `bk build wait`    | `ci_finished`                             |
| Graph DB (own state)| SQLite reads on a tick                       | `ticket_frontier_changed`, `milestone_gate_open`, `slot_available` |
| Tracker (Linear …)  | **cannot** — delegated to the session        | `delegate action="refresh_graph"`         |

The frontier and gate events are computed from the same derivation layer
(`derive.mts` / `queries.mts`) the `graph` commands already use, so the CLI and
the session always agree on what is ready.

### How the two loops become event handlers

**`orchestrate`.** The `/loop`-driven tick loop goes away. The session opens,
optionally does one bootstrap tick, then yields. Thereafter each `<channel>`
event is one tick's worth of work: on `ticket_frontier_changed` or
`slot_available`, dispatch the newly-ready coordinators; on `milestone_gate_open`,
run `milestone-review`; on `delegate refresh_graph`, refresh from the tracker.
The dynamic cadence table moves from `orchestrate/reference.md` into the CLI.

**`deliver`.** The `sleep`+`pr-status` loop goes away. When the session opens a
PR it calls `watch_pr`; then it yields. The CLI watches CI and reviewers and
pushes `ci_finished` / `pr_review` / `pr_state_change`. Each event wakes the
session to run deliver's existing per-tick judgment **once** — address
actionable concerns, evaluate gates — then yield again. On merge/close the
session calls `unwatch_pr`. Deliver's judgment (§2.4) is unchanged; only the
waiting is relocated.

This is the same intent as §3.1 — hold the wait outside the agent — but
delivered by pushing into a warm session rather than cold-spawning a runner per
event.

### Injection safety

Channel content is injected into the session and is influenced by whoever can
comment on a PR or ticket. The rule: **the CLI pushes minimal, structured
events, never raw external text.** An event carries IDs, states, and counts —
"1 failing check (build)", "review: changes_requested by @x" — and the session
reads the actual bodies through `pr-status`, which is already the sanctioned,
sole PR read path. Delegation events carry only an action and identifiers. Meta
keys are `snake_case` identifiers (`[A-Za-z0-9_]`; hyphens are silently dropped
by the channel layer, so `pr-number` would vanish — use `pr`).

If two-way permission relay is ever enabled (the channel forwarding tool-approval
prompts to a remote device), the sender-gating and untrusted-field rules from
the channel reference apply; that is out of scope for the first cut.

## Deployment and lifecycle

- **Always-on = a persistent session.** Channels deliver only while a session is
  open. The orchestrator runs in a long-lived session (persistent terminal,
  `tmux`, or a background `claude` process). When it exits, `dispatch serve`
  exits with it and waiting stops until it is restarted.
- **Restart is cheap and stateless-in-the-server.** All durable state is in the
  shared SQLite DB and on the platforms. On restart the server rehydrates its
  watch set from the graph DB (open claims, un-merged PRs) — it stores no
  conversation history and needs no event spool of its own.
- **Preview flags.** Until `dispatch` is allowlisted, the session starts with
  `--dangerously-load-development-channels`. Org `channelsEnabled` must be on.
  Document both in the plugin README; fail loudly at `serve` startup if the
  channel capability is refused.

## Relationship to §3.1

§3.1 solved the same problem — keep work alive across CI/review/ticket gaps —
with a **separate machine-wide daemon that cold-spawns a fresh runner per
event** (`--resume <session-id>`, prompt templates, PID lock, `events/` spool,
crash recovery). This design keeps §3.1's *analysis* and discards its *delivery
mechanism*:

**Kept (moved into `dispatch serve`):** the event taxonomy, coalescing,
mutable-follow-up accumulation, the dynamic polling-interval table, and the
per-source strategy ladder (SDK watch → watch subprocess → polling).

**Dropped:** cold-spawn-per-event, prompt-template resolution, the runner spawn
contract, the PID lock and single-daemon-per-machine rule, and the on-disk
event spool. A warm session replaces all of it: no prompt templates (the session
already has its skills loaded), no session-id capture/resume (the session is
continuous), no runner binary abstraction.

The spec change: §3.1 is reframed from "Daemon" to the channel server, and a new
normative subsection specifies the **channel message protocol** (the three
message kinds, meta-field vocabulary, and coalescing rules). That spec work is
tracked separately from this design doc; this doc is the implementation-facing
rationale.

### Deferred: multi-session orchestration

§3.1's genuinely harder concerns — many independent sessions on one machine, a
global live-runner cap, FIFO admission, cross-session crash recovery — only
arise when work is spread across *separate* sessions. The first cut runs one
long-lived orchestrator session that drives coordinators and deliver as
subagents within it, so a single `dispatch serve` serves everything and those
concerns do not apply. If the model later fans out to independent sessions, the
old daemon's machine-wide bookkeeping is the reference for what returns — which
is why the analysis is preserved, not deleted.

## Phased plan

1. **Channel skeleton.** `dispatch serve` speaks the channel protocol; declares
   the capability; pushes a hand-triggered test event. Prove delivery into a
   session end-to-end behind the dev flag.
2. **Graph-DB events + orchestrate.** Watch the shared graph DB; emit
   `ticket_frontier_changed` / `milestone_gate_open` / `slot_available`. Convert
   `orchestrate` from a `/loop` ticker to an event handler. Add `dispatch_ticket`
   delegation and the `request_refresh_soon` steer tool.
3. **Tracker delegation.** Emit `refresh_graph` delegation on the tracker
   cadence; `build-graph` becomes the delegation's handler. Retire
   `orchestrate`'s self-timed tracker reads.
4. **PR/CI events + deliver.** `watch_pr` / `unwatch_pr` tools; watch CI and
   reviewers; emit `ci_finished` / `pr_review` / `pr_state_change`. Convert
   `deliver` from a `sleep` loop to an event handler. This is the largest slice
   and retires the heaviest poller.
5. **Cadence + hardening.** Port the dynamic-interval table; coalescing;
   restart-rehydration from the graph DB; startup checks for the channel
   capability and org policy.

## Open questions

- **Command name.** `dispatch serve` vs `dispatch mcp` vs a reframed `dispatch
  daemon`. `serve` reads as "long-running process"; `mcp` mirrors the user's
  framing ("available over MCP").
- **`ack` as tool vs DB row.** Delegation idempotency could ride entirely on the
  graph DB (a delegation row the session clears) instead of an MCP tool. Fewer
  tools is better if the DB can carry it.
- **Coordinators: subagents vs sessions.** The first cut assumes coordinators and
  deliver run as subagents inside the one orchestrator session. If a coordinator
  should be its own session, it needs its own `dispatch serve` — reopening the
  multi-session concerns deferred above. Worth deciding before phase 4.
- **Delegation liveness.** If the session is mid-task when a delegation is pushed,
  it coalesces to the next turn — fine. But if the session has exited, the
  delegation is dropped silently (channel notifications are not acknowledged).
  The restart path must re-derive outstanding delegations from DB state rather
  than trusting delivery.
- **Buildkite vs GitHub Actions CI.** `ci_finished` needs a provider abstraction;
  `gh pr checks --watch` and `bk build wait` are different subprocesses with
  different terminal signals.
