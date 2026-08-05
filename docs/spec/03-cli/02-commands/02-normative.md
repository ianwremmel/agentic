# §3.2.2 — Commands: Normative (Server and Work-Registration Commands)

All `dispatch` commands exit 0 on success and non-zero on error. Errors are
written to stderr; structured output is written to stdout.

The channel server (§3.1) is spawned per session by the runner; there is no
process to start or stop by hand and no prompt templates to manage. Work to
monitor lives in the graph (§2.6), not in a separate task store.

---

## Server command

### `dispatch mcp`

Run the channel server (§3.1) in stdio MCP mode. It is spawned by the session
runner as a subprocess — declared like any MCP server in plugin `.mcp.json` and
named in the session's `--channels` list — not launched by the operator directly.
Behavior per §3.1.2. There is no `start`/`stop`: the server's lifetime is the
session's.

### `dispatch mcp ack`

Record that this session received the server's `probe` event — the mode marker
(§3.1.2). The session runs it in answer to the probe, passing back the registry
id the probe carried.

```shell
dispatch mcp ack --server <registry-id>
```

It MUST be idempotent: a repeated ack for the same registry id refreshes the
marker rather than erroring, since the server re-pushes the probe until one
lands.

It MUST also write its own session id onto that registry row (§3.1.2), replacing
whatever the server recorded at spawn. This is the one command a session runs
while the server it answers is already known, so it is where the id a later
caller matches on gets fixed to the session that actually holds the channel. A
repeated ack rewrites it, so a server that outlives one session id converges on
the current one instead of stranding its claims. The acknowledgement itself is
recorded against the registry id, not the session id, so it never transfers to a
different server (§3.1.2).

### `dispatch tick`

Run one scheduler pass for the caller's session and print the resulting
events — owed ingest instructions first, then work orders — to stdout in
delivery order, one `<event kind="…" …>body</event>` line each. This is the
fallback-mode counterpart of the server's timer tick (§3.1.2): the caller
reads the output synchronously, so delivery is proven by the call itself and
the channel acknowledgement is not required. Orders it emits are claimed and
budget-bounded exactly as the server's are; a session polling `tick` MUST NOT
also launch work from `dispatch queue`, whose entries are unclaimed.

```shell
dispatch tick [--session <registry-id>] [--max-parallel <n>]
```

CLI-only — it is not exposed as an MCP tool, because a session whose channel
works receives the same events as pushes and a second emitter would race the
timer tick. Given no `--session`, it correlates to the caller's own live
server row (§3.1.2) and heartbeats it; no live row is an error, not a silent
no-op, and the error path runs before any instruction is marked delivered.

Synchronous delivery is proof the caller received the bytes, not that it
acted on them. Where a tick's output is lost anyway (a killed session, a
truncated read), recovery is the same as for a lost channel push: claims
sweep when the session's server dies (§2.6), and re-running
`dispatch refresh` re-offers unanswered instructions.

### `dispatch mcp status`

Report whether channel mode is active, plus basic health: the PRs being watched,
the last poll tick, and any pending delegations.

```shell
dispatch mcp status [--server <registry-id>]
```

Skills call this to select channel vs fallback mode; it reports `active` only for
a live server whose probe has been acked (§3.1.2). It MUST succeed whether or not
a server is attached, reporting `inactive` when it cannot confirm one, so a skill
always gets an answer. Given no `--server`, it MUST find the server registered
for the caller's own session id (§3.1.2). Only the `probe` event carries a
registry id, so every caller except the one answering a probe correlates this
way. Where that yields no acked live server it MUST report `inactive` with the
reason (`no-session-id`, `no-server-for-session`, `ambiguous-session`, or
`awaiting-ack`) rather than report on a server that may belong to another
session.

`--server` names a registry id explicitly and takes precedence over the match,
but not over the fail-closed rule: where the caller has a session id of its own
and the named row does not carry that id, the command MUST report `inactive`
with `no-server-for-session` rather than answer about another session's server
(§3.1.2). An operator's terminal carries no session id, which is what makes
`--server` the way to ask about a specific server.

---

## Work registration

Work lives in the graph database (§2.6); there is no separate task registry
and no command that "launches the daemon." Work enters the graph three ways:

1. **Tracker projects and tickets** are written through the flat commands
   (`dispatch project set`, `milestone set`, `ticket set`, `edge add|rm|set`)
   in answer to the server's ingest instructions, opened by
   `dispatch refresh --tracker T --project P[,P]` and closed by
   `dispatch refresh done [--cursor]`. Because reading a tracker may require
   the session's MCP client, the fetching is session work; the deciding is the
   CLI's (§3.1.2).
2. **A bare pull request or prompt item** is injected with
   `dispatch pr set --injected`, and a runtime-injected ticket with
   `dispatch ticket set --injected`; both rank to the head of the queue.
3. **Claiming is the server's**: the scheduler claims a node before emitting
   its work order. Workers report through `dispatch outcome set` (releasing
   claim and slot), hold compute with `dispatch slot acquire`/`release` —
   blocking on a full ledger with `dispatch slot wait`, a CLI-only command
   that does the ledger polling itself so a worker's wait costs one
   foreground call — and open milestone gates with `dispatch review record`
   (or `dispatch review release` to end a review with the gate closed).
4. **PR waits are the server's too**: a pr-worker that reaches a wait point
   (CI running, a reviewer pending, awaiting merge) MUST hand it off with
   `dispatch pr watch --id <item> --for ci|review|merge` and return, instead
   of polling the PR in-band. The handoff arms the watch with the PR's
   fingerprint as of that moment — a change that lands before the first
   server poll still fires — and releases the caller's own claim and slot,
   never another session's. The server fingerprints the PR on its tick
   (§3.1.2's polling strategy and intervals) and a change re-queues the item
   as a `resume` pass, whose worker re-derives where the PR stands and
   continues. Every watch also expires on a per-reason deadline and fires
   unconditionally: the fingerprint cannot see out-of-band signals (a
   ticket-side approval, a reaction on the engagement comment), so the
   periodic resume is what surfaces them; a resumed worker that finds
   nothing new just re-arms. The watch survives its dispatch — only an
   outcome report or a fresh watch removes it — so a crashed resume
   re-serves as `resume`, not as fresh work.

The registry views are `dispatch status` (counts, milestone gates, anomalies,
the terminal verdict) and `dispatch queue` (what the scheduler would hand out
next). Cross-session concurrency and stale-claim recovery are governed by §2.6
and §3.1.2 (Multi-session).
