# §3.2.2 — Commands: Normative (Server and Work-Registration Commands)

All `dispatch` commands exit 0 on success and non-zero on error. Errors are
written to stderr; structured output is written to stdout.

This section supersedes the daemon and prompt-template command surface. With the
channel server (§3.1) there is no daemon to start or stop, and no prompt
templates to manage: the server is spawned per session by the runner, and work to
monitor lives in the graph (§2.6), not in a separate task store.

---

## Server command

### `dispatch mcp`

Run the channel server (§3.1) in stdio MCP mode. It is spawned by the session
runner as a subprocess — registered like any MCP server via plugin `.mcp.json` or
`--channels` — not launched by the operator directly. Behavior per §3.1.2. There
is no `start`/`stop`: the server's lifetime is the session's.

### `dispatch mcp status`

Report whether channel mode is active for the current session, plus basic health:
the PRs being watched, the last poll tick, and any pending delegations.

```shell
dispatch mcp status
```

Skills call this (alongside the spawn-time environment marker) to select channel
vs fallback mode. It MUST succeed whether or not a server is attached, reporting
`inactive` when none is, so mode selection is deterministic.

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
