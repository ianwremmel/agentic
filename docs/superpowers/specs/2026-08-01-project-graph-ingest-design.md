# Project graph ingest

How a project's tickets, milestones, and dependencies get into the graph DB when
the tracker is reachable only through the agent's MCP client.

The CLI owns the reasoning: it decides what still needs fetching and instructs the
agent over the channel. The agent scans and writes; it never decides what to fetch
next.

## Scope

In: the graph write commands, the refresh state machine and its durable
bookkeeping, and the channel push that carries fetch instructions.

Out: the derived read-model (`available`/`blocked`/`counts`/`anomalies`,
`graph doc`, `graph summary`), the probe/ack handshake and polling fallback,
claims/slots/work orders, bare-PR injection, and any tracker API adapter. A
tracker with a code path of its own would fetch in-process instead of delegating;
none exists yet, so delegation is the only implemented path.

## Command surface

New commands under `src/commands/graph/`, one file each.

| Command                                     | Purpose                                           |
| ------------------------------------------- | ------------------------------------------------- |
| `graph refresh --tracker T --project P[,P]` | Open or resume a refresh. Returns an ack.         |
| `graph refresh done [--cursor TOKEN]`       | Agent asserts the scan is complete.               |
| `graph refresh status`                      | Print refresh state and open instructions.        |
| `graph project set` / `rm`                  | Upsert or delete a project.                       |
| `graph milestone set` / `rm`                | Upsert or delete a milestone.                     |
| `graph ticket set` / `rm`                   | Upsert or delete a ticket.                        |
| `graph ticket missing --id X`               | The tracker has no such ticket.                   |
| `graph edge add` / `rm` / `set`             | One edge, or redeclare every blocker of one node. |
| `graph reset`                               | Drop graph content for a full rebuild.            |

`ticket` and `--status` replace the legacy CLI's `task` and `--role`, matching
`src/lib/model` (`Ticket`, `Status`). The `build-graph` skill is rewritten to
match.

There is no `graph cursor` command. The cursor is read when a scan instruction is
built and written by `graph refresh done`, so it advances exactly when a scan
closes and can never run ahead of what was recorded.

## Refresh state machine

One row per tracker source.

| State       | Meaning                           | A write that creates a placeholder |
| ----------- | --------------------------------- | ---------------------------------- |
| `idle`      | nothing in flight                 | emit a `fetch_ticket` instruction  |
| `scanning`  | a project scan is in flight       | record it; emit nothing            |
| `resolving` | placeholder fetches are in flight | emit a `fetch_ticket` instruction  |

Suppression during `scanning` is the point of the distinction: a scan writes
edges before it writes their endpoints, so emitting on every dangling reference
would produce a fetch instruction for most of the project and then immediately
satisfy it.

The loop:

1. `graph refresh` opens the row in `scanning`, queues one `scan_project`
   instruction carrying the project ids and the persisted cursor, and returns an
   ack. Nothing else rides the tool result.
2. The server drains the queue after the tool call returns and pushes the
   instruction over the channel.
3. The agent scans tickets filtered by project (and by the cursor, when one was
   supplied), then writes each project, milestone, ticket, and edge. An edge
   naming an id nobody has written materializes a `node` row with `kind='unknown'`
   — the existing `materialize.mts` behavior. Placeholders accumulate silently.
4. `graph refresh done --cursor <token>` flushes: every `unknown` node becomes a
   `fetch_ticket` instruction, the token is held on the refresh row as a pending
   cursor, and the state moves to `resolving`. With no placeholders the refresh
   closes instead — cursor written, state `idle`.
5. In `resolving`, a write that materializes a placeholder satisfies its request;
   a write that creates a new placeholder emits another instruction immediately.
   `graph ticket missing` satisfies a request without materializing it.
6. The refresh closes when no request is open: the pending cursor is written, the
   refresh's `fetch_request` rows are cleared, and the state moves to `idle`.
   Clearing the rows is what scopes "for the rest of the refresh" below — a
   `missing` resolution constrains this refresh and no later one.

`graph refresh` against a row already in `scanning` or `resolving` under a live
session is idempotent: it returns the same ack and re-drains undelivered
instructions rather than opening a second refresh. Under a session that is stale
by the existing session-staleness rule, it takes the refresh over.

### Ids that resolve to nothing

A deleted ticket, or one on another tracker (which §2.3 forbids as a dependency),
never materializes. `graph ticket missing --id X` is how the agent says so. The
request is resolved `missing`, which:

- keeps the placeholder node — deleting it would cascade away the edges that
  referenced it, and those edges are real information;
- suppresses re-emission for that id for the rest of the refresh, so a later edge
  touching the same id does not restart the loop.

Nodes left `unknown` with a `missing` resolution are what the anomalies section
will report once the derived read-model exists.

## Instructions and the channel

`fetch_request` is a durable queue. Each row carries a `kind`, a JSON `payload`,
`delivered_at`, and a `resolution` of `null`, `materialized`, or `missing`.

| kind           | payload                           | asks the agent to                                   |
| -------------- | --------------------------------- | --------------------------------------------------- |
| `scan_project` | project ids, cursor (may be null) | scan every ticket in those projects since the cursor |
| `fetch_ticket` | one ticket id                     | fetch that ticket                                   |

Commands never touch the channel; they write rows. After `tools/call` returns,
the server drains undelivered rows and writes one `notifications/claude/channel`
per row. Per §3.1.2: `seq` increases monotonically per server, meta keys match
`^[a-zA-Z_][a-zA-Z0-9_]*$`, every value is stringified, and the server sets no
`source` key — the runner sets that one. `initialize` gains
`capabilities.experimental['claude/channel']`.

Draining after the tool call is enough for this slice because every instruction
originates from a tool call the agent just made. The background poll tick arrives
with the slice that watches PRs.

Two divergences from §3.1.2's event catalog, both recorded here deliberately:

- The catalog has one `refresh_graph` kind, which carries neither the
  scan-vs-resolve distinction nor a cursor. New kinds are permitted; these two
  replace it for this workflow.
- The catalog's rule that a work order waits for the probe acknowledgement does
  not apply, because no work order is emitted here and the handshake is out of
  scope. This slice assumes the channel works. `graph refresh status` is the
  escape hatch when it does not.

## Plumbing

`withDatabase(flags, env, fn)` in `lib/db` resolves the path (`--db`, then
`DISPATCH_DB`, then `$XDG_STATE_HOME/dispatch/graph.db`), opens, and closes in a
`finally` so no command leaves a lock for the next tick to wait out. A shared
`DB_OPTION` const gives every graph command the same flag. The server's drain
opens its own short-lived handle; WAL is already on.

Two new stores beside the existing ones:

- `RefreshStore` — the state machine, including takeover of a refresh whose
  session is stale.
- `FetchRequestStore` — the queue: enqueue, mark delivered, resolve, and the
  open-request count that closes a refresh.

`SCHEMA_VERSION` bumps to 2 for the two new tables. The DB is a rebuildable
cache, so the recovery is delete-and-re-sync; there is no migration.

## Errors

Each is a `UsageError` or `DataError` whose hint names the field and the fix, per
`lib/errors`:

- a `--status` outside the vocabulary, which lists the vocabulary;
- `graph refresh done` with no open refresh;
- `graph ticket missing` for an id with no open request;
- an edge that would close a cycle, already rejected by `EdgeStore`.

## Testing

One rule per test:

- a placeholder created during `scanning` emits no instruction;
- `graph refresh done` with dangling ids emits exactly those and leaves the
  cursor unadvanced;
- `graph refresh done` with a clean graph closes the refresh and writes the
  cursor;
- a write during `resolving` that creates a placeholder emits immediately;
- `graph ticket missing` satisfies its request without materializing the node,
  and a later edge to that id emits nothing;
- the refresh closes only once no request is open;
- the drain emits one notification per undelivered row, with increasing `seq` and
  no `source` key;
- a refresh whose session is stale is taken over rather than duplicated;
- an edge closing a cycle is refused with its hint intact.
