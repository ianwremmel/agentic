# Dispatch persistence layer design

The database schema, domain stores, and support code for the rewritten Dispatch
CLI (`plugins/dispatch/src`). Replaces the old `plugins/dispatch/cli` design,
which put everything under a single `graph` subcommand and one 1000-line
`GraphStore`.

## Goals

- Model the entity kinds — project, milestone, ticket, pr/prompt — as siblings
  over a shared identity table, so any of them can block any other.
- Make agent liveness a first-class concept (`session`) so a dead MCP server's
  claims and compute slots are reclaimed automatically.
- Organize access around concepts (one store per concept), not tables, and keep
  each store small enough that no god-object reforms.

## Entity model

One base identity table, one satellite per kind, a single blocking edge
relation. A 1:1 scoping partition (a ticket's or milestone's project) is an FK
column; every many-to-many gate (milestone membership, dependencies) is an
`edge`.

- `node` is the base identity. Every entity — project, milestone, ticket, pr —
  is a node, so edges and claims reference one id space with real foreign keys.
- `node.id` is an INTEGER for cheap joins; `external_id` is the tracker/forge
  identifier the CLI's input and output actually speak (`CLC-945`, a project
  slug, `acme/api#412`).
- `kind = 'unknown'` is a placeholder: an id named by an edge or an FK before its
  own row has been fetched. Placeholders let a sync write in any order under
  foreign keys; a node's kind is promoted when its satellite row arrives. This
  also subsumes the old `declared` flag — a project merely referenced by a ticket
  is a `kind='unknown'` placeholder until it is synced and promoted to
  `kind='project'`.
- Timestamps are TEXT ISO-8601 UTC (`2026-07-31T12:00:00.000Z`): raw rows stay
  human-readable when inspecting the database, recency compares lexicographically,
  and the one staleness sweep uses `unixepoch()`.

### Kinds and their satellites

| Kind        | Satellite carries                                                                       |
| ----------- | --------------------------------------------------------------------------------------- |
| `project`   | `name`                                                                                  |
| `milestone` | `project_id`, `name`                                                                    |
| `ticket`    | `project_id`, `url`, `title`, `status`, `target_kind`, `requires_human`, dispatch hints |
| `pr`        | `ticket_id?`, `origin`, forge identity (`repo`, `pr_number`, `url`, `branch`), `title`  |

The old schema fused "the tracker ticket" and "the delivery unit" into one
`task`. Splitting them is the central change:

- A `ticket` is the tracker's unit. It carries `status` and `target_kind`.
- A `pr` is the delivery unit. `ticket_id` is nullable, so a bare PR or a raw
  user prompt has no originating ticket.
- The old `target_kind = 'bare-pr'` disappears: a bare PR is now a `pr` node with
  `ticket_id NULL`, so `target_kind` collapses to `pr` / `verification` /
  `human-only` on the ticket.

### Milestone membership is a blocking edge

There is no `milestone_id` FK and no membership table. A ticket that belongs to a
milestone **blocks** it: the milestone cannot be reviewed until its tickets are
done. Membership is therefore a `ticket → milestone` edge, the same relation as
any dependency. Consequences:

- The "members" of a milestone are its ticket blockers — the set `review_member`
  snapshots at review time.
- A ticket may block several milestones (many-to-many), which is what some
  trackers need.
- Milestone sequencing (review milestone M1 before M2 starts) is a
  `milestone → milestone` (or `milestone → ticket`) edge — uniform with the rest.

### A milestone node resolves differently from a ticket

"Does this node still block its dependents?" is kind-dependent:

- A **ticket** stops blocking when `status ∈ {verified, canceled}`.
- A **milestone** stops blocking when its **review is recorded** over the current
  member set (the `review` / `review_member` tables). Its members completing makes
  it *ready for review*; the recorded review makes it *resolved*.

### Vocabulary

`status` and `target_kind` are tracker-neutral; adapters map native tracker
states onto them, and all downstream reasoning speaks only these.

- **`ticket.status`** — workflow state: `backlog`, `paused`, `awaiting-external`,
  `available`, `in-progress`, `in-review`, `finished`, `delivered`, `verified`,
  `canceled`. Drives effective-blocking (a `verified`/`canceled` ancestor stops
  blocking its dependents) and the frontier (`available` is the pickup set).
  `status_group` is the coarse bucket (backlog / unstarted / started / completed /
  canceled).
- **`ticket.target_kind`** — what working the ticket produces: `pr`,
  `verification`, `human-only`.
- **`ticket.requires_human`** — a static flag (set from a tracker label/field via
  config) meaning the ticket inherently needs a human in the loop, so no
  autonomous coordinator is dispatched for it. Distinct from the *runtime* parked
  state (`status = awaiting-external`/`paused`).
- **`pr.origin`** — how the delivery unit entered the system:

| Value     | Meaning                                                                          |
| --------- | -------------------------------------------------------------------------------- |
| `prompt`  | A raw user prompt; no PR exists yet.                                             |
| `ticket`  | A worker starting a ticket.                                                      |
| `adopted` | A PR created by a human or another system, driven for the first time.            |
| `resumed` | A PR dispatch worked in a previous session that was interrupted, picked back up. |

## Liveness and cleanup

`session` is the only liveness primitive. Claims and slots carry no heartbeat of
their own — they cascade off the session that owns them.

- A **session** is one MCP server process (`id` = the MCP session id, shared by
  all subagents of a Claude Code instance). Liveness is the *process* lifecycle,
  not agent tool activity.
- A **claim** is a lock on a work item (the coordinator/PR/milestone lock). One
  per node (PK is `node_id`).
- A **slot** is a compute-capacity token: the right to build/test on the host.
  `N` per session, global `COUNT(*)` bounded by `MAX_PARALLEL` at acquire.
  `UNIQUE(session_id, actor)` makes acquire idempotent — a unit that acquires
  twice refreshes its row instead of leaking a second slot.

`actor` is a caller-supplied label naming the unit *within* a shared session
(`coordinator:CLC-945`, `worker:acme/api#412`, `review:M2`) — the MCP session id
cannot distinguish subagents, so per-unit identity must be passed in. It is the
idempotency key on `slot` and observability metadata on `claim`.

Three cleanup paths:

1. **Clean exit** — the MCP server deletes its own `session` row on shutdown;
   `ON DELETE CASCADE` reaps its claims and slots in one statement.
2. **Unclean death** — the process's periodic heartbeat stops; a sweep deletes
   any `session` whose `heartbeat_at` is past a staleness window, cascading the
   same cleanup. This sweep is the *only* place staleness is judged.
3. **Explicit release** — a unit that finishes deletes its own claim/slot
   directly, without waiting for its session to end.

There is deliberately **no per-item stale-lock reclamation**. A hung subagent
inside a live instance keeps its claim until it releases or the whole instance
dies — correct, because subagents share the session and a hung child blocks its
parent anyway.

## Schema

`STRICT` tables throughout. `PRAGMA foreign_keys = ON` is required — the cascade
cleanup is inert without it. Timestamp columns are TEXT ISO-8601 UTC, validated
on write (RFC 3339 shape, as the old CLI did before parsing).

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE node (
  id          INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('project','milestone','ticket','pr','unknown'))
) STRICT;

CREATE TABLE project (
  node_id INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  name    TEXT NOT NULL
) STRICT;

CREATE TABLE milestone (
  node_id    INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES node(id),
  name       TEXT NOT NULL
) STRICT;

CREATE TABLE ticket (
  node_id        INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  project_id     INTEGER NOT NULL REFERENCES node(id),
  url            TEXT NOT NULL,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN (
                   'backlog','paused','awaiting-external','available','in-progress',
                   'in-review','finished','delivered','verified','canceled')),
  target_kind    TEXT NOT NULL CHECK (target_kind IN ('pr','verification','human-only')),
  requires_human INTEGER NOT NULL CHECK (requires_human IN (0,1)),
  injected       INTEGER NOT NULL CHECK (injected IN (0,1)),
  priority       REAL,
  branch_hint    TEXT,
  labels         TEXT NOT NULL,  -- JSON array; read/written whole, never queried across
  updated_at     TEXT
) STRICT;

CREATE TABLE pr (
  node_id    INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  ticket_id  INTEGER REFERENCES node(id),
  origin     TEXT NOT NULL CHECK (origin IN ('prompt','ticket','adopted','resumed')),
  repo       TEXT,
  pr_number  INTEGER,
  url        TEXT,
  branch     TEXT,
  title      TEXT NOT NULL,
  injected   INTEGER NOT NULL CHECK (injected IN (0,1)),
  priority   REAL,
  updated_at TEXT
) STRICT;

CREATE TABLE edge (
  blocker INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  blocked INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker, blocked),
  CHECK (blocker <> blocked)
) STRICT;

CREATE TABLE session (
  id           TEXT PRIMARY KEY,  -- the MCP session id
  host         TEXT,
  pid          INTEGER,
  started_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
) STRICT;

CREATE TABLE claim (
  node_id    INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  actor      TEXT,
  worktree   TEXT,
  branch     TEXT,
  claimed_at TEXT NOT NULL
) STRICT;

CREATE TABLE slot (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  UNIQUE (session_id, actor)
) STRICT;

CREATE TABLE outcome (
  node_id     INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  outcome     TEXT NOT NULL CHECK (outcome IN
                ('verified','canceled','delivered','human-blocked','decomposed','failed')),
  retryable   INTEGER CHECK (retryable IN (0,1)),  -- meaningful only for 'failed'
  detail      TEXT,
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE review (
  milestone_id INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  recorded_at  TEXT NOT NULL
) STRICT;

-- Pins a review to the member set it covered, by external id and without a node
-- FK: the review is a historical fact about tracker ids and must not mutate when
-- a member is later deleted. A review that files follow-up tickets into the
-- milestone therefore stops satisfying the gate.
CREATE TABLE review_member (
  milestone_id       INTEGER NOT NULL REFERENCES review(milestone_id) ON DELETE CASCADE,
  member_external_id TEXT NOT NULL,
  PRIMARY KEY (milestone_id, member_external_id)
) STRICT;

CREATE TABLE cursor (
  source TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) STRICT;

CREATE INDEX ticket_project    ON ticket (project_id);
CREATE INDEX milestone_project ON milestone (project_id);
CREATE INDEX pr_ticket         ON pr (ticket_id);
CREATE INDEX edge_blocked      ON edge (blocked);
CREATE INDEX claim_session     ON claim (session_id);
```

## Module organization

Organized around concepts, one store per concept, each doing both reads and
writes of its concept. `graph` happens to be read-heavy (cross-node derivation);
`ticket`/`pr`/etc. are both read and write. Low-level connection code is separate
from the stores.

```text
lib/db/       Database (connection, pragmas, tx, guard); schema.mts (DDL + SCHEMA_VERSION).
              Low-level, no domain knowledge.
lib/model/    domain types + row↔model mappers: Project, Milestone, Ticket, Pr, Edge,
              Session, Claim, Slot, plus derived read types (ClassifiedNode,
              MilestoneState, counts, anomalies). No SQL here.
lib/stores/   one store per concept:
                project.mts      ProjectStore      — read + write projects
                milestone.mts    MilestoneStore    — read + write milestones; recordReview
                ticket.mts       TicketStore       — read + write tickets
                pr.mts           PrStore           — read + write prs
                edge.mts         EdgeStore         — add/remove/setEdges; cycle rejection
                graph.mts        GraphStore        — cross-node derivation: frontier,
                                                     classification, milestone state,
                                                     anomalies, counts, cursor reads
                session.mts      SessionStore      — register / heartbeat / close / sweepStale
                coordination.mts CoordinationStore — claims + slots + outcomes
                materialize.mts  shared internal   — placeholder create/promote,
                                                     id-kind conflict
```

A store is organized around a concept, not restricted to one table: a single
operation may write several tables atomically. `CoordinationStore.recordOutcome`
writes `outcome` and releases the claim and slot in one transaction (the artifact
proves its writer exited); `MilestoneStore.recordReview` writes `review` /
`review_member` and releases the review agent's milestone claim. Derivation that
spans kinds (a milestone's ready-for-review needs its member tickets' status)
lives in `GraphStore`.

### Accessor surface

Sketch, not final signatures. All methods are `async` (facade over synchronous
`node:sqlite`).

- **ProjectStore / MilestoneStore / TicketStore / PrStore**: `upsert*`,
  `remove*`, and per-kind reads. Writes enforce every rule a single write can
  judge — CHECK/FK constraints, id-kind conflicts, placeholder promotion legality.
- **EdgeStore**: `addEdge`, `removeEdge`, `setEdges(node, direction, others)`;
  rejects an edge that would close a cycle.
- **GraphStore**: `classifiedNodes`, `frontier`/`dispatchQueue`,
  `milestoneStates`, `anomalies`, `counts`, `getCursor`, node/edge lookups,
  `reset()`.
- **SessionStore**: `register`, `heartbeat`, `close`, `sweepStale(now, window)`.
- **CoordinationStore**: `claim`/`release`/`claims`,
  `acquireSlot`/`releaseSlot`/`slotCount`, `recordOutcome`/`clearOutcome`.
- **MilestoneStore**: `recordReview` (with the member snapshot).

## Support code

Ports the old `Database` class's proven choices into `lib/db/`, on the src error
taxonomy (`EnvironmentError` / `DataError` from `lib/errors`):

- `PRAGMA journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`.
- `BEGIN IMMEDIATE` transactions (every transaction here writes; a deferred begin
  that reads first cannot upgrade to a writer under concurrency).
- `guard()` turns a locked/unwritable database into an `EnvironmentError` — a fact
  about the machine, not a bug in how the CLI was called.
- Timestamp writes validated as RFC 3339 before storage (V8 also accepts local
  formats, which would record an instant the caller never meant).
- Async method signatures over synchronous `node:sqlite`, so an async driver later
  is a change behind the facade rather than a rewrite of every call site.

**No migrations.** The database is a rebuildable cache: the graph re-derives from
a full producer sync, and sessions/claims/slots are pure runtime state.
`Database.open` refuses a file whose recorded `SCHEMA_VERSION` differs; recovery
is "delete the file and re-sync." Keep `SCHEMA_VERSION` and the `meta` table.

## Deferred

- `wait_sample` (per-repo CI/reviewer/merge timing history) — a delivery-worker
  optimization, added when the worker needs it, not part of this layer.
