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

### `dispatch mcp status`

Report whether channel mode is active, plus basic health: the PRs being watched,
the last poll tick, and any pending delegations.

```shell
dispatch mcp status [--server <registry-id>]
```

Skills call this to select channel vs fallback mode; it reports `active` only for
a live server whose probe has been acked (§3.1.2). It MUST succeed whether or not
a server is attached, reporting `inactive` when none is, so a skill always gets an
answer. `--server` names the registry id to check; a skill woken by a channel
event has it, and one starting cold does not — see the correlation gap in §3.1.2's
mode marker.

---

## Work registration

Work to monitor lives in the graph database (§2.6); there is no separate task
registry and no command that "launches the daemon." A session's server monitors
the work that session has claimed and its open PRs. Work enters the graph in
three ways:

1. **Tracker projects and tickets** are registered by running the graph producer
   (the `build-graph` skill) against the tracker and writing the result through
   the `dispatch graph` commands. Because reading a tracker may require the
   session's MCP client, this is session work — it is not a standalone CLI command
   that fetches a tracker. The server can prompt it with a `refresh_graph`
   delegation (§3.1.2).
2. **A bare pull request** is injected with `dispatch graph pr add`, which records
   a ticketless PR as a top-priority work item (see the graph command surface).
3. **Claiming** (`dispatch graph next --claim`) is what makes a node this
   session's to watch; releasing or recording an outcome removes it from active
   monitoring.

The registry view is `dispatch graph doc` / `dispatch graph summary`; there is no
separate `tasks list`. Cross-session concurrency and stale-claim recovery are
governed by §2.6 and §3.1.2 (Multi-session).
