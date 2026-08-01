# Project graph ingest implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent build a tracker's project graph in the dispatch DB, with the CLI deciding what still needs fetching and pushing those instructions over the MCP channel.

**Architecture:** Two new tables (`refresh`, `fetch_request`) hold a per-tracker state machine and a durable instruction queue. A `RefreshService` derives every decision from the database — satisfy requests whose ticket now exists, chase placeholder nodes, close a refresh with nothing outstanding — and every write command calls its `reconcile()` unconditionally. The MCP server drains undelivered rows into `notifications/claude/channel` after each tool call.

**Tech Stack:** TypeScript `.mts` on Node's native type stripping (no build step, no runtime dependencies), `node:sqlite`, `node:test`, `node:util` `parseArgs`.

Design: [2026-08-01-project-graph-ingest-design.md](../specs/2026-08-01-project-graph-ingest-design.md).

## Global constraints

- Node `>=24.18.0`. All source is `.mts`, run unbuilt. No runtime dependencies.
- Import sibling modules by real path with extension: `./log/logger.mts`.
- Tests are colocated: `foo.mts` → `foo.test.mts`. Run with `npm test` (`node --test "plugins/**/*.test.mts" "scripts/**/*.test.mts"`).
- `npm run lint`, `npm run typecheck`, and `npm test` must pass before any push. `npm run lint:fix` also formats.
- Keep source files under ~200 lines. One exported class per file. Every `lib` folder has a barrel `index.mts`.
- **No non-command files under `src/commands/`.** `discover` loads every non-`.test.mts` file there and requires a `Command` class export whose `name` matches the file basename. Helpers go in `src/lib/`. `*.test.mts` files are skipped by discovery and are fine.
- Prefer promise-based APIs. `node:sqlite` is sync, so stores keep the async facade and the file-level `/* eslint-disable @typescript-eslint/require-await */` comment the existing stores use.
- Errors are `DispatchError` subclasses from `src/lib/errors/` carrying a `hint` written for the agent that has to fix the failure. Use `ensure(cond, () => new UsageError(msg, {hint}))`.
- No spec section references (`§2.6`) in anything an agent reads at run time: skill markdown, CLI output, error strings. Code comments and design docs may cite them.
- Conventional commit messages. Never add `Co-Authored-By: Claude` or a "Generated with" trailer.
- Markdown tables in docs and skills use aligned source-level column widths.

Two carried-forward decisions the design doc records, restated because tasks depend on them:

- Milestone membership is an edge, not a column: a ticket belongs to a milestone by blocking it (`ticket → milestone`). `ticket set` therefore has no `--milestone` flag; the skill writes `edge add --blocker <ticket> --blocked <milestone>`.
- `target-kind` and `requires-human` are explicit flags on `ticket set` in this slice (`--target-kind` defaults to `pr`). Deriving them from labels needs a config layer that does not exist yet.

---

## File structure

**Created**

| Path                                                | Responsibility                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `src/lib/stores/refresh.mts`                        | `RefreshStore` — the per-source state row.                            |
| `src/lib/stores/fetch-request.mts`                  | `FetchRequestStore` — the instruction queue.                          |
| `src/lib/refresh/placeholders.mts`                  | Placeholder queries: which nodes are unknown, and whose tracker.      |
| `src/lib/refresh/refresh-service.mts`               | `RefreshService` — every emission and close decision.                 |
| `src/lib/refresh/index.mts`                         | Barrel.                                                                |
| `src/lib/db/with-database.mts`                      | `withDatabase`, `resolveDbPath`, `DB_OPTION`.                         |
| `src/lib/command/test-support.mts`                  | `runCommand` — invoke a command with a capturing io. Not in the barrel. |
| `src/lib/mcp/channel.mts`                           | `ChannelWriter` — notification framing, `seq`, meta-key filtering.    |
| `src/lib/mcp/drain.mts`                             | `drainInstructions` — queue rows and completions to notifications.    |
| `src/commands/project/set.mts`, `rm.mts`            | Project writes.                                                        |
| `src/commands/milestone/set.mts`, `rm.mts`          | Milestone writes.                                                      |
| `src/commands/ticket/set.mts`, `rm.mts`, `missing.mts` | Ticket writes and the not-found signal.                             |
| `src/commands/edge/add.mts`, `rm.mts`, `set.mts`    | Edge writes.                                                           |
| `src/commands/refresh.mts`                          | Open or resume a refresh.                                              |
| `src/commands/refresh/done.mts`, `status.mts`       | Scan completion; state readout.                                        |
| `commands/orchestrate.md`                           | The `/orchestrate` slash command.                                      |

**Modified**

| Path                            | Change                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| `src/lib/db/schema.mts`         | Two tables, a project column, `SCHEMA_VERSION` → 2.           |
| `src/lib/db/index.mts`          | Export `with-database.mts`.                                    |
| `src/lib/db/CLAUDE.md`          | Document `with-database.mts`.                                  |
| `src/lib/model/types.mts`       | `Project.source`.                                              |
| `src/lib/stores/project.mts`    | Read and write `source`.                                       |
| `src/lib/stores/index.mts`      | Export the two new stores.                                     |
| `src/lib/stores/CLAUDE.md`      | Describe the two new stores.                                   |
| `src/lib/mcp/mcp.mts`           | Declare the channel capability; drain after `tools/call`.     |
| `src/lib/mcp/mcp.test.mts`      | Point `DISPATCH_DB` at a temp file so the drain has a DB.     |
| `src/lib/mcp/CLAUDE.md`         | Describe `channel.mts` and `drain.mts`.                        |
| `skills/orchestrate/SKILL.md`   | Rewrite as the resident instruction handler.                   |
| `skills/build-graph/SKILL.md`   | Rewrite as a single-instruction handler.                       |
| `skills/build-graph/reference.md` | Flat command reference.                                      |
| `.claude-plugin/plugin.json`    | Version bump.                                                  |

All paths are relative to `plugins/dispatch/` unless they start with `docs/`.

---

### Task 1: Schema — refresh bookkeeping and project source

**Files:**

- Modify: `plugins/dispatch/src/lib/db/schema.mts`
- Modify: `plugins/dispatch/src/lib/model/types.mts:4-7`
- Modify: `plugins/dispatch/src/lib/stores/project.mts`
- Test: `plugins/dispatch/src/lib/stores/project.test.mts`

**Interfaces:**

- Consumes: nothing.
- Produces: `Project` gains `source: string | null`. `ProjectStore.upsertProject({id: string; name: string; source?: string | null})`. Tables `refresh` and `fetch_request` per the DDL below. `SCHEMA_VERSION === 2`.

- [ ] **Step 1: Write the failing test**

Append to `plugins/dispatch/src/lib/stores/project.test.mts`:

```ts
it('round-trips the tracker source', async () => {
  const db = await Database.open(':memory:');
  const store = new ProjectStore(db);
  await store.upsertProject({id: 'P', name: 'Proj', source: 'linear'});
  assert.deepEqual(await store.getProject('P'), {
    id: 'P',
    name: 'Proj',
    source: 'linear',
  });
  await db.close();
});
```

If the file's existing imports do not already include `Database` and `ProjectStore`, add them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/project.test.mts`
Expected: FAIL — the returned object has no `source` key.

- [ ] **Step 3: Add the schema**

In `plugins/dispatch/src/lib/db/schema.mts`, change `SCHEMA_VERSION` to `2`, add `source TEXT` to the `project` table, and append the two tables plus their index before the `CREATE INDEX` block:

```sql
CREATE TABLE IF NOT EXISTS project (
  node_id INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  source  TEXT
) STRICT;
```

```sql
CREATE TABLE IF NOT EXISTS refresh (
  source                TEXT PRIMARY KEY,
  state                 TEXT NOT NULL CHECK (state IN ('scanning','resolving','idle')),
  session_id            TEXT,
  projects              TEXT NOT NULL,
  pending_cursor        TEXT,
  started_at            TEXT NOT NULL,
  completed_at          TEXT,
  completion_emitted_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS fetch_request (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('scan_project','fetch_ticket')),
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  delivered_at TEXT,
  resolution   TEXT CHECK (resolution IN ('materialized','missing'))
) STRICT;
```

Add to the index block:

```sql
CREATE INDEX IF NOT EXISTS fetch_request_open ON fetch_request (source, resolution);
```

`refresh.session_id` is deliberately not a foreign key: a refresh must outlive the staleness sweep that reaps its session, which is the case takeover exists for. Add that as a comment above the table.

- [ ] **Step 4: Add `source` to the model and the store**

In `plugins/dispatch/src/lib/model/types.mts`:

```ts
export interface Project {
  id: string;
  name: string;
  /** The tracker this project came from; null until a write names one. */
  source: string | null;
}
```

In `plugins/dispatch/src/lib/stores/project.mts`, replace `upsertProject` and the `getProject` return:

```ts
  async upsertProject(project: {
    id: string;
    name: string;
    source?: string | null;
  }): Promise<void> {
    await this.#db.transaction(() => {
      const nodeId = materialize(this.#db, project.id, 'project');
      this.#db.run(
        `INSERT INTO project (node_id, name, source) VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           name = excluded.name, source = excluded.source`,
        [nodeId, project.name, project.source ?? null]
      );
    });
  }
```

```ts
  async getProject(id: string): Promise<Project | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS id, p.name AS name, p.source AS source
       FROM project p JOIN node n ON n.id = p.node_id
       WHERE n.external_id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      source: row.source === null ? null : String(row.source),
    };
  }
```

- [ ] **Step 5: Run the store tests and repair the existing assertions**

Run: `node --test plugins/dispatch/src/lib/stores/project.test.mts`
Expected: the new test PASSES; any pre-existing `getProject` `deepEqual` assertion FAILS on the new `source` key. Add `source: null` to each of those expected objects and re-run until all pass.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. If a database test asserts `SCHEMA_VERSION`, update it to 2.

- [ ] **Step 7: Commit**

```bash
git add plugins/dispatch/src/lib/db/schema.mts plugins/dispatch/src/lib/model/types.mts plugins/dispatch/src/lib/stores/project.mts plugins/dispatch/src/lib/stores/project.test.mts
git commit -m "feat: add refresh bookkeeping tables and project source"
```

---

### Task 2: RefreshStore

**Files:**

- Create: `plugins/dispatch/src/lib/stores/refresh.mts`
- Test: `plugins/dispatch/src/lib/stores/refresh.test.mts`
- Modify: `plugins/dispatch/src/lib/stores/index.mts`

**Interfaces:**

- Consumes: `Database` (`../db/database.mts`), `assertInstant` (`../db/time.mts`), the `refresh` table from Task 1.
- Produces:

```ts
export type RefreshState = 'scanning' | 'resolving' | 'idle';
export interface RefreshRow {
  source: string;
  state: RefreshState;
  sessionId: string | null;
  projects: string[];
  pendingCursor: string | null;
  startedAt: string;
  completedAt: string | null;
  completionEmittedAt: string | null;
}
export class RefreshStore {
  constructor(db: Database);
  get(source: string): Promise<RefreshRow | null>;
  active(): Promise<RefreshRow[]>;
  open(input: {source: string; projects: readonly string[]; sessionId: string | null; at: string}): Promise<void>;
  openResolving(input: {source: string; sessionId: string | null; at: string}): Promise<void>;
  setState(source: string, state: RefreshState): Promise<void>;
  setPendingCursor(source: string, cursor: string): Promise<void>;
  close(source: string, at: string): Promise<void>;
  markCompletionEmitted(source: string, at: string): Promise<void>;
  pendingCompletions(): Promise<string[]>;
  hasLiveSession(source: string): Promise<boolean>;
}
```

- [ ] **Step 1: Write the failing tests**

Create `plugins/dispatch/src/lib/stores/refresh.test.mts`:

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {RefreshStore} from './refresh.mts';

const AT = '2026-08-01T12:00:00.000Z';
const LATER = '2026-08-01T12:05:00.000Z';

async function fresh(): Promise<{db: Database; store: RefreshStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new RefreshStore(db)};
}

describe('RefreshStore', () => {
  it('opens a scanning refresh carrying its projects', async () => {
    const {db, store} = await fresh();
    await store.open({source: 'linear', projects: ['P1', 'P2'], sessionId: 's1', at: AT});
    const row = await store.get('linear');
    assert.equal(row?.state, 'scanning');
    assert.deepEqual(row?.projects, ['P1', 'P2']);
    assert.equal(row?.pendingCursor, null);
    await db.close();
  });

  it('re-opening resets the state and clears the pending cursor', async () => {
    const {db, store} = await fresh();
    await store.open({source: 'linear', projects: ['P1'], sessionId: 's1', at: AT});
    await store.setPendingCursor('linear', 'tok');
    await store.setState('linear', 'resolving');
    await store.open({source: 'linear', projects: ['P2'], sessionId: 's2', at: LATER});
    const row = await store.get('linear');
    assert.equal(row?.state, 'scanning');
    assert.equal(row?.pendingCursor, null);
    assert.equal(row?.sessionId, 's2');
    await db.close();
  });

  it('reports a closed refresh as owing a completion push exactly once', async () => {
    const {db, store} = await fresh();
    await store.open({source: 'linear', projects: [], sessionId: null, at: AT});
    await store.close('linear', LATER);
    assert.deepEqual(await store.pendingCompletions(), ['linear']);
    await store.markCompletionEmitted('linear', LATER);
    assert.deepEqual(await store.pendingCompletions(), []);
    assert.equal((await store.get('linear'))?.state, 'idle');
    await db.close();
  });

  it('has no live session when no session row carries its id', async () => {
    const {db, store} = await fresh();
    await store.open({source: 'linear', projects: [], sessionId: 'gone', at: AT});
    assert.equal(await store.hasLiveSession('linear'), false);
    await db.close();
  });

  it('active omits idle sources', async () => {
    const {db, store} = await fresh();
    await store.open({source: 'a', projects: [], sessionId: null, at: AT});
    await store.open({source: 'b', projects: [], sessionId: null, at: AT});
    await store.close('b', LATER);
    assert.deepEqual((await store.active()).map((r) => r.source), ['a']);
    await db.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/refresh.test.mts`
Expected: FAIL — cannot resolve `./refresh.mts`.

- [ ] **Step 3: Write the store**

Create `plugins/dispatch/src/lib/stores/refresh.mts`:

```ts
import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export const REFRESH_STATES = ['scanning', 'resolving', 'idle'] as const;
export type RefreshState = (typeof REFRESH_STATES)[number];

export interface RefreshRow {
  source: string;
  state: RefreshState;
  sessionId: string | null;
  projects: string[];
  pendingCursor: string | null;
  startedAt: string;
  completedAt: string | null;
  completionEmittedAt: string | null;
}

const COLUMNS = `source, state, session_id, projects, pending_cursor,
                 started_at, completed_at, completion_emitted_at`;

/**
 * One row per tracker source: which phase its ingest is in, who owns it, and
 * whether its completion event still owes a push.
 */
export class RefreshStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async open(input: {
    source: string;
    projects: readonly string[];
    sessionId: string | null;
    at: string;
  }): Promise<void> {
    assertInstant(input.at, 'at');
    this.#upsert(
      input.source,
      'scanning',
      input.sessionId,
      JSON.stringify([...input.projects]),
      input.at
    );
  }

  async openResolving(input: {
    source: string;
    sessionId: string | null;
    at: string;
  }): Promise<void> {
    assertInstant(input.at, 'at');
    this.#upsert(input.source, 'resolving', input.sessionId, '[]', input.at);
  }

  async setState(source: string, state: RefreshState): Promise<void> {
    this.#db.run('UPDATE refresh SET state = ? WHERE source = ?', [
      state,
      source,
    ]);
  }

  async setPendingCursor(source: string, cursor: string): Promise<void> {
    this.#db.run('UPDATE refresh SET pending_cursor = ? WHERE source = ?', [
      cursor,
      source,
    ]);
  }

  async close(source: string, at: string): Promise<void> {
    assertInstant(at, 'at');
    this.#db.run(
      `UPDATE refresh
       SET state = 'idle', completed_at = ?, completion_emitted_at = NULL,
           pending_cursor = NULL
       WHERE source = ?`,
      [at, source]
    );
  }

  async markCompletionEmitted(source: string, at: string): Promise<void> {
    assertInstant(at, 'at');
    this.#db.run(
      'UPDATE refresh SET completion_emitted_at = ? WHERE source = ?',
      [at, source]
    );
  }

  async pendingCompletions(): Promise<string[]> {
    return this.#db
      .all(
        `SELECT source FROM refresh
         WHERE completed_at IS NOT NULL AND completion_emitted_at IS NULL
         ORDER BY source`
      )
      .map((row) => String(row.source));
  }

  async hasLiveSession(source: string): Promise<boolean> {
    return (
      this.#db.get(
        `SELECT 1 FROM refresh r
         JOIN session s ON s.id = r.session_id
         WHERE r.source = ?`,
        [source]
      ) !== undefined
    );
  }

  async get(source: string): Promise<RefreshRow | null> {
    const row = this.#db.get(
      `SELECT ${COLUMNS} FROM refresh WHERE source = ?`,
      [source]
    );
    return row === undefined ? null : toRow(row);
  }

  async active(): Promise<RefreshRow[]> {
    return this.#db
      .all(
        `SELECT ${COLUMNS} FROM refresh WHERE state <> 'idle' ORDER BY source`
      )
      .map(toRow);
  }

  #upsert(
    source: string,
    state: RefreshState,
    sessionId: string | null,
    projects: string,
    at: string
  ): void {
    this.#db.run(
      `INSERT INTO refresh (${COLUMNS})
       VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL)
       ON CONFLICT(source) DO UPDATE SET
         state = excluded.state, session_id = excluded.session_id,
         projects = excluded.projects, pending_cursor = NULL,
         started_at = excluded.started_at, completed_at = NULL,
         completion_emitted_at = NULL`,
      [source, state, sessionId, projects, at]
    );
  }
}

function toRow(row: Record<string, unknown>): RefreshRow {
  return {
    source: String(row.source),
    state: row.state as RefreshState,
    sessionId: row.session_id === null ? null : String(row.session_id),
    projects: JSON.parse(String(row.projects)) as string[],
    pendingCursor:
      row.pending_cursor === null ? null : String(row.pending_cursor),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    completionEmittedAt:
      row.completion_emitted_at === null
        ? null
        : String(row.completion_emitted_at),
  };
}

/* eslint-enable @typescript-eslint/require-await */
```

- [ ] **Step 4: Export it from the barrel**

Add to `plugins/dispatch/src/lib/stores/index.mts`:

```ts
export * from './refresh.mts';
```

- [ ] **Step 5: Run the tests**

Run: `node --test plugins/dispatch/src/lib/stores/refresh.test.mts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/dispatch/src/lib/stores/refresh.mts plugins/dispatch/src/lib/stores/refresh.test.mts plugins/dispatch/src/lib/stores/index.mts
git commit -m "feat: add RefreshStore"
```

---

### Task 3: FetchRequestStore

**Files:**

- Create: `plugins/dispatch/src/lib/stores/fetch-request.mts`
- Test: `plugins/dispatch/src/lib/stores/fetch-request.test.mts`
- Modify: `plugins/dispatch/src/lib/stores/index.mts`

**Interfaces:**

- Consumes: `Database`, `assertInstant`, the `fetch_request` table from Task 1.
- Produces:

```ts
export type FetchKind = 'scan_project' | 'fetch_ticket';
export type FetchResolution = 'materialized' | 'missing';
export interface ScanPayload {projects: string[]; cursor: string | null}
export interface TicketPayload {ticket: string}
export interface FetchRequest {
  id: number;
  source: string;
  kind: FetchKind;
  payload: ScanPayload | TicketPayload;
  createdAt: string;
  deliveredAt: string | null;
  resolution: FetchResolution | null;
}
export class FetchRequestStore {
  constructor(db: Database);
  enqueueScan(input: {source: string; projects: readonly string[]; cursor: string | null; at: string}): Promise<number>;
  enqueueTicket(input: {source: string; ticket: string; at: string}): Promise<number | null>;
  undelivered(): Promise<FetchRequest[]>;
  markDelivered(id: number, at: string): Promise<void>;
  resolve(id: number, resolution: FetchResolution): Promise<void>;
  openTickets(): Promise<{id: number; source: string; ticket: string}[]>;
  openTicketRequest(ticket: string): Promise<{id: number; source: string} | null>;
  bySource(source: string): Promise<FetchRequest[]>;
  openCount(source: string): Promise<number>;
  clear(source: string): Promise<number>;
}
```

- [ ] **Step 1: Write the failing tests**

Create `plugins/dispatch/src/lib/stores/fetch-request.test.mts`:

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {FetchRequestStore} from './fetch-request.mts';

const AT = '2026-08-01T12:00:00.000Z';

async function fresh(): Promise<{db: Database; store: FetchRequestStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new FetchRequestStore(db)};
}

describe('FetchRequestStore', () => {
  it('enqueues a scan and returns it parsed', async () => {
    const {db, store} = await fresh();
    await store.enqueueScan({
      source: 'linear',
      projects: ['P1'],
      cursor: 'tok',
      at: AT,
    });
    const [request] = await store.undelivered();
    assert.equal(request.kind, 'scan_project');
    assert.deepEqual(request.payload, {projects: ['P1'], cursor: 'tok'});
    await db.close();
  });

  it('enqueues one ticket request per id', async () => {
    const {db, store} = await fresh();
    assert.notEqual(
      await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT}),
      null
    );
    assert.equal(
      await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT}),
      null
    );
    assert.equal(await store.openCount('linear'), 1);
    await db.close();
  });

  it('a resolved ticket request still suppresses a re-enqueue', async () => {
    const {db, store} = await fresh();
    const id = await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT});
    assert.notEqual(id, null);
    await store.resolve(id as number, 'missing');
    assert.equal(
      await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT}),
      null
    );
    assert.equal(await store.openCount('linear'), 0);
    await db.close();
  });

  it('marking delivered takes a row out of the drain', async () => {
    const {db, store} = await fresh();
    await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT});
    const [request] = await store.undelivered();
    await store.markDelivered(request.id, AT);
    assert.deepEqual(await store.undelivered(), []);
    await db.close();
  });

  it('openTickets lists only unresolved ticket requests', async () => {
    const {db, store} = await fresh();
    await store.enqueueScan({source: 'linear', projects: [], cursor: null, at: AT});
    const id = await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT});
    await store.enqueueTicket({source: 'linear', ticket: 'B', at: AT});
    await store.resolve(id as number, 'materialized');
    assert.deepEqual(
      (await store.openTickets()).map((t) => t.ticket),
      ['B']
    );
    await db.close();
  });

  it('clear empties one source', async () => {
    const {db, store} = await fresh();
    await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT});
    await store.enqueueTicket({source: 'jira', ticket: 'B', at: AT});
    assert.equal(await store.clear('linear'), 1);
    assert.equal(await store.openCount('jira'), 1);
    await db.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/fetch-request.test.mts`
Expected: FAIL — cannot resolve `./fetch-request.mts`.

- [ ] **Step 3: Write the store**

Create `plugins/dispatch/src/lib/stores/fetch-request.mts`:

```ts
import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export const FETCH_KINDS = ['scan_project', 'fetch_ticket'] as const;
export type FetchKind = (typeof FETCH_KINDS)[number];
export type FetchResolution = 'materialized' | 'missing';

export interface ScanPayload {
  projects: string[];
  cursor: string | null;
}

export interface TicketPayload {
  ticket: string;
}

export interface FetchRequest {
  id: number;
  source: string;
  kind: FetchKind;
  payload: ScanPayload | TicketPayload;
  createdAt: string;
  deliveredAt: string | null;
  resolution: FetchResolution | null;
}

const COLUMNS = 'id, source, kind, payload, created_at, delivered_at, resolution';

/**
 * The durable instruction queue. A ticket request is keyed by its serialized
 * payload, so a row that was already resolved `missing` still suppresses a
 * re-enqueue — that is what stops one dead reference restarting the loop.
 */
export class FetchRequestStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async enqueueScan(input: {
    source: string;
    projects: readonly string[];
    cursor: string | null;
    at: string;
  }): Promise<number> {
    assertInstant(input.at, 'at');
    const payload: ScanPayload = {
      projects: [...input.projects],
      cursor: input.cursor,
    };
    return this.#insert(
      input.source,
      'scan_project',
      JSON.stringify(payload),
      input.at
    );
  }

  async enqueueTicket(input: {
    source: string;
    ticket: string;
    at: string;
  }): Promise<number | null> {
    assertInstant(input.at, 'at');
    const payload = JSON.stringify({ticket: input.ticket} satisfies TicketPayload);
    const existing = this.#db.get(
      `SELECT id FROM fetch_request
       WHERE source = ? AND kind = 'fetch_ticket' AND payload = ?`,
      [input.source, payload]
    );
    if (existing !== undefined) return null;
    return this.#insert(input.source, 'fetch_ticket', payload, input.at);
  }

  async undelivered(): Promise<FetchRequest[]> {
    return this.#db
      .all(
        `SELECT ${COLUMNS} FROM fetch_request
         WHERE delivered_at IS NULL AND resolution IS NULL
         ORDER BY id`
      )
      .map(toRequest);
  }

  async markDelivered(id: number, at: string): Promise<void> {
    assertInstant(at, 'at');
    this.#db.run('UPDATE fetch_request SET delivered_at = ? WHERE id = ?', [
      at,
      id,
    ]);
  }

  async resolve(id: number, resolution: FetchResolution): Promise<void> {
    this.#db.run('UPDATE fetch_request SET resolution = ? WHERE id = ?', [
      resolution,
      id,
    ]);
  }

  async openTickets(): Promise<{id: number; source: string; ticket: string}[]> {
    return this.#db
      .all(
        `SELECT id, source, payload FROM fetch_request
         WHERE kind = 'fetch_ticket' AND resolution IS NULL
         ORDER BY id`
      )
      .map((row) => ({
        id: Number(row.id),
        source: String(row.source),
        ticket: (JSON.parse(String(row.payload)) as TicketPayload).ticket,
      }));
  }

  async openTicketRequest(
    ticket: string
  ): Promise<{id: number; source: string} | null> {
    const row = this.#db.get(
      `SELECT id, source FROM fetch_request
       WHERE kind = 'fetch_ticket' AND resolution IS NULL AND payload = ?`,
      [JSON.stringify({ticket} satisfies TicketPayload)]
    );
    return row === undefined
      ? null
      : {id: Number(row.id), source: String(row.source)};
  }

  async bySource(source: string): Promise<FetchRequest[]> {
    return this.#db
      .all(
        `SELECT ${COLUMNS} FROM fetch_request WHERE source = ? ORDER BY id`,
        [source]
      )
      .map(toRequest);
  }

  /**
   * Outstanding ticket requests. Deliberately not counting the `scan_project`
   * row: nothing ever resolves it, and a refresh in `scanning` is already held
   * open by its state. Counting it would mean no refresh ever closes.
   */
  async openCount(source: string): Promise<number> {
    const row = this.#db.get(
      `SELECT COUNT(*) AS n FROM fetch_request
       WHERE source = ? AND kind = 'fetch_ticket' AND resolution IS NULL`,
      [source]
    );
    return row === undefined ? 0 : Number(row.n);
  }

  async clear(source: string): Promise<number> {
    return this.#db.run('DELETE FROM fetch_request WHERE source = ?', [source]);
  }

  #insert(
    source: string,
    kind: FetchKind,
    payload: string,
    at: string
  ): number {
    this.#db.run(
      `INSERT INTO fetch_request (source, kind, payload, created_at)
       VALUES (?, ?, ?, ?)`,
      [source, kind, payload, at]
    );
    const row = this.#db.get(
      'SELECT id FROM fetch_request ORDER BY id DESC LIMIT 1'
    );
    return row === undefined ? 0 : Number(row.id);
  }
}

function toRequest(row: Record<string, unknown>): FetchRequest {
  return {
    id: Number(row.id),
    source: String(row.source),
    kind: row.kind as FetchKind,
    payload: JSON.parse(String(row.payload)) as ScanPayload | TicketPayload,
    createdAt: String(row.created_at),
    deliveredAt: row.delivered_at === null ? null : String(row.delivered_at),
    resolution:
      row.resolution === null ? null : (row.resolution as FetchResolution),
  };
}

/* eslint-enable @typescript-eslint/require-await */
```

- [ ] **Step 4: Export it from the barrel**

Add to `plugins/dispatch/src/lib/stores/index.mts`:

```ts
export * from './fetch-request.mts';
```

- [ ] **Step 5: Run the tests**

Run: `node --test plugins/dispatch/src/lib/stores/fetch-request.test.mts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/dispatch/src/lib/stores/fetch-request.mts plugins/dispatch/src/lib/stores/fetch-request.test.mts plugins/dispatch/src/lib/stores/index.mts
git commit -m "feat: add FetchRequestStore"
```

---

### Task 4: RefreshService

The largest task: every emission and close decision lives here, and the rest of the plan calls only `reconcile()`.

**Files:**

- Create: `plugins/dispatch/src/lib/refresh/placeholders.mts`
- Create: `plugins/dispatch/src/lib/refresh/refresh-service.mts`
- Create: `plugins/dispatch/src/lib/refresh/index.mts`
- Test: `plugins/dispatch/src/lib/refresh/refresh-service.test.mts`

**Interfaces:**

- Consumes: `RefreshStore`, `FetchRequestStore` (Tasks 2–3), `CursorStore`, `findNode` (all from `../stores/index.mts`), `Database`, `nowIso`, `ensure`, `UsageError`.
- Produces:

```ts
export function unknownNodeIds(db: Database): string[];
export function sourceForPlaceholder(db: Database, externalId: string): string | null;
export class RefreshService {
  constructor(db: Database, now?: () => string);
  startScan(input: {source: string; projects: readonly string[]; sessionId: string | null; rebuild: boolean}): Promise<{resumed: boolean}>;
  completeScan(input: {source: string; cursor: string | null}): Promise<{state: RefreshState; pending: string[]}>;
  markMissing(ticket: string): Promise<void>;
  reconcile(): Promise<void>;
  status(source: string): Promise<{refresh: RefreshRow | null; requests: FetchRequest[]}>;
}
```

- [ ] **Step 1: Write the failing tests**

Create `plugins/dispatch/src/lib/refresh/refresh-service.test.mts`:

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {UsageError} from '../errors/index.mts';
import {
  CursorStore,
  EdgeStore,
  FetchRequestStore,
  ProjectStore,
  RefreshStore,
  TicketStore,
} from '../stores/index.mts';
import type {Ticket} from '../model/types.mts';
import {RefreshService} from './refresh-service.mts';

const AT = '2026-08-01T12:00:00.000Z';

function ticket(id: string, project: string): Ticket {
  return {
    id,
    project,
    url: `https://example.test/${id}`,
    title: id,
    status: 'available',
    targetKind: 'pr',
    requiresHuman: false,
    injected: false,
    priority: null,
    branchHint: null,
    labels: [],
    updatedAt: null,
  };
}

interface Harness {
  db: Database;
  service: RefreshService;
  requests: FetchRequestStore;
  refreshes: RefreshStore;
  cursors: CursorStore;
  tickets: TicketStore;
  edges: EdgeStore;
}

async function fresh(): Promise<Harness> {
  const db = await Database.open(':memory:');
  await new ProjectStore(db).upsertProject({
    id: 'P',
    name: 'P',
    source: 'linear',
  });
  return {
    db,
    service: new RefreshService(db, () => AT),
    requests: new FetchRequestStore(db),
    refreshes: new RefreshStore(db),
    cursors: new CursorStore(db),
    tickets: new TicketStore(db),
    edges: new EdgeStore(db),
  };
}

describe('RefreshService', () => {
  it('starts a scan carrying the persisted cursor', async () => {
    const h = await fresh();
    await h.cursors.setCursor('linear', 'tok');
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    const [request] = await h.requests.undelivered();
    assert.equal(request.kind, 'scan_project');
    assert.deepEqual(request.payload, {projects: ['P'], cursor: 'tok'});
    await h.db.close();
  });

  it('emits nothing for a placeholder written during a scan', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('MISSING', 'T1');
    await h.service.reconcile();
    const kinds = (await h.requests.undelivered()).map((r) => r.kind);
    assert.deepEqual(kinds, ['scan_project']);
    await h.db.close();
  });

  it('completing a scan with a dangling id asks for exactly that id and holds the cursor', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('MISSING', 'T1');
    const result = await h.service.completeScan({
      source: 'linear',
      cursor: 'tok',
    });
    assert.equal(result.state, 'resolving');
    assert.deepEqual(result.pending, ['MISSING']);
    assert.equal(await h.cursors.getCursor('linear'), null);
    await h.db.close();
  });

  it('completing a clean scan closes the refresh and writes the cursor', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    const result = await h.service.completeScan({
      source: 'linear',
      cursor: 'tok',
    });
    assert.equal(result.state, 'idle');
    assert.equal(await h.cursors.getCursor('linear'), 'tok');
    await h.db.close();
  });

  it('writing the requested ticket satisfies the request and closes the refresh', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('MISSING', 'T1');
    await h.service.completeScan({source: 'linear', cursor: 'tok'});
    await h.tickets.upsertTicket(ticket('MISSING', 'P'));
    await h.service.reconcile();
    assert.equal((await h.refreshes.get('linear'))?.state, 'idle');
    assert.equal(await h.cursors.getCursor('linear'), 'tok');
    await h.db.close();
  });

  it('markMissing satisfies the request without materializing, and the id is not asked for again', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('GONE', 'T1');
    await h.edges.addEdge('LATER', 'T1');
    await h.service.completeScan({source: 'linear', cursor: 'tok'});

    await h.service.markMissing('GONE');
    // The refresh stays open on LATER, and GONE is still an unknown node.
    assert.equal((await h.refreshes.get('linear'))?.state, 'resolving');
    assert.equal(await h.tickets.getTicket('GONE'), null);

    // A fresh reference to GONE inside the same refresh asks for nothing more.
    await h.tickets.upsertTicket(ticket('T2', 'P'));
    await h.edges.addEdge('GONE', 'T2');
    await h.service.reconcile();
    assert.deepEqual(
      (await h.requests.openTickets()).map((t) => t.ticket),
      ['LATER']
    );
    await h.db.close();
  });

  it('rejects markMissing for an id nobody asked for', async () => {
    const h = await fresh();
    await assert.rejects(
      h.service.markMissing('NOPE'),
      (err: unknown) => err instanceof UsageError
    );
    await h.db.close();
  });

  it('a placeholder written while idle opens a resolving refresh', async () => {
    const h = await fresh();
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('MISSING', 'T1');
    await h.service.reconcile();
    assert.equal((await h.refreshes.get('linear'))?.state, 'resolving');
    assert.deepEqual(
      (await h.requests.openTickets()).map((t) => t.ticket),
      ['MISSING']
    );
    await h.db.close();
  });

  it('rebuild drops the graph and scans with no cursor', async () => {
    const h = await fresh();
    await h.cursors.setCursor('linear', 'tok');
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: true,
    });
    const [request] = await h.requests.undelivered();
    assert.deepEqual(request.payload, {projects: ['P'], cursor: null});
    assert.equal(await h.tickets.getTicket('T1'), null);
    await h.db.close();
  });

  it('refuses to complete a scan that was never started', async () => {
    const h = await fresh();
    await assert.rejects(
      h.service.completeScan({source: 'linear', cursor: null}),
      (err: unknown) => err instanceof UsageError
    );
    await h.db.close();
  });
});
```

Note the last `rebuild` test: `startScan` with `rebuild: true` deletes every node, including the project whose `source` the placeholder logic needs. That is correct — the scan re-writes the project first.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/dispatch/src/lib/refresh/refresh-service.test.mts`
Expected: FAIL — cannot resolve `./refresh-service.mts`.

- [ ] **Step 3: Write the placeholder queries**

Create `plugins/dispatch/src/lib/refresh/placeholders.mts`:

```ts
import type {Database} from '../db/database.mts';

/** Every node an edge referenced that nobody has since written. */
export function unknownNodeIds(db: Database): string[] {
  return db
    .all("SELECT external_id FROM node WHERE kind = 'unknown' ORDER BY id")
    .map((row) => String(row.external_id));
}

/**
 * Which tracker a placeholder belongs to. A placeholder carries no project of
 * its own, so the tracker comes from a ticket on the other end of an edge
 * touching it — the only thing that can have referenced it.
 */
export function sourceForPlaceholder(
  db: Database,
  externalId: string
): string | null {
  const row = db.get(
    `SELECT p.source AS source
     FROM node n
     JOIN edge e ON (e.blocker = n.id OR e.blocked = n.id)
     JOIN ticket t
       ON t.node_id = (CASE WHEN e.blocker = n.id THEN e.blocked ELSE e.blocker END)
     JOIN project p ON p.node_id = t.project_id
     WHERE n.external_id = ? AND p.source IS NOT NULL
     LIMIT 1`,
    [externalId]
  );
  return row === undefined ? null : String(row.source);
}
```

- [ ] **Step 4: Write the service**

Create `plugins/dispatch/src/lib/refresh/refresh-service.mts`:

```ts
import type {Database} from '../db/database.mts';
import {nowIso} from '../db/time.mts';
import {ensure, UsageError} from '../errors/index.mts';
import {
  CursorStore,
  FetchRequestStore,
  findNode,
  RefreshStore,
} from '../stores/index.mts';
import type {
  FetchRequest,
  RefreshRow,
  RefreshState,
} from '../stores/index.mts';
import {sourceForPlaceholder, unknownNodeIds} from './placeholders.mts';

/**
 * Every decision about what to fetch next and when a refresh is done. All of it
 * derives from the database, so `reconcile` is idempotent and a write command
 * can call it unconditionally without knowing which phase it is in.
 */
export class RefreshService {
  readonly #db: Database;
  readonly #refreshes: RefreshStore;
  readonly #requests: FetchRequestStore;
  readonly #cursors: CursorStore;
  readonly #now: () => string;

  constructor(db: Database, now: () => string = nowIso) {
    this.#db = db;
    this.#refreshes = new RefreshStore(db);
    this.#requests = new FetchRequestStore(db);
    this.#cursors = new CursorStore(db);
    this.#now = now;
  }

  /** Open a refresh, or report that a live one already owns this source. */
  async startScan(input: {
    source: string;
    projects: readonly string[];
    sessionId: string | null;
    rebuild: boolean;
  }): Promise<{resumed: boolean}> {
    const existing = await this.#refreshes.get(input.source);
    if (
      existing !== null &&
      existing.state !== 'idle' &&
      (await this.#refreshes.hasLiveSession(input.source))
    ) {
      return {resumed: true};
    }

    if (input.rebuild) {
      await this.#db.transaction(() => this.#db.run('DELETE FROM node'));
      await this.#cursors.clearCursor(input.source);
    }

    const at = this.#now();
    await this.#requests.clear(input.source);
    await this.#refreshes.open({
      source: input.source,
      projects: input.projects,
      sessionId: input.sessionId,
      at,
    });
    const cursor = await this.#cursors.getCursor(input.source);
    await this.#requests.enqueueScan({
      source: input.source,
      projects: input.projects,
      cursor,
      at,
    });
    return {resumed: false};
  }

  /** The agent has written everything its scan found. */
  async completeScan(input: {
    source: string;
    cursor: string | null;
  }): Promise<{state: RefreshState; pending: string[]}> {
    const row = await this.#refreshes.get(input.source);
    ensure(
      row !== null && row.state === 'scanning',
      () =>
        new UsageError(`no scan is in progress for ${input.source}`, {
          hint: 'start one with `dispatch refresh --tracker <id> --project <id>` before reporting it done.',
        })
    );

    if (input.cursor !== null) {
      await this.#refreshes.setPendingCursor(input.source, input.cursor);
    }
    await this.#refreshes.setState(input.source, 'resolving');
    await this.reconcile();

    const after = await this.#refreshes.get(input.source);
    const pending = (await this.#requests.openTickets())
      .filter((request) => request.source === input.source)
      .map((request) => request.ticket);
    return {state: after?.state ?? 'idle', pending};
  }

  /** The tracker has no such ticket; stop asking for it. */
  async markMissing(ticket: string): Promise<void> {
    const request = await this.#requests.openTicketRequest(ticket);
    ensure(
      request !== null,
      () =>
        new UsageError(`nothing asked for ticket ${ticket}`, {
          hint: 'only a ticket the CLI requested can be reported missing — check `dispatch refresh status`.',
        })
    );
    await this.#requests.resolve(request.id, 'missing');
    await this.reconcile();
  }

  async status(
    source: string
  ): Promise<{refresh: RefreshRow | null; requests: FetchRequest[]}> {
    return {
      refresh: await this.#refreshes.get(source),
      requests: await this.#requests.bySource(source),
    };
  }

  /**
   * Bring every source back in line with the graph. Three passes, in order:
   * satisfy requests whose ticket now exists, chase placeholders nobody is
   * fetching, close whatever has nothing outstanding.
   */
  async reconcile(): Promise<void> {
    const at = this.#now();

    for (const request of await this.#requests.openTickets()) {
      const node = findNode(this.#db, request.ticket);
      if (node !== null && node.kind !== 'unknown') {
        await this.#requests.resolve(request.id, 'materialized');
      }
    }

    // A scan writes edges before their endpoints, so under one every reference
    // is briefly dangling; chasing them there would ask for most of the project.
    for (const externalId of unknownNodeIds(this.#db)) {
      const source = sourceForPlaceholder(this.#db, externalId);
      if (source === null) continue;
      const row = await this.#refreshes.get(source);
      if (row?.state === 'scanning') continue;
      if (row === null || row.state === 'idle') {
        await this.#refreshes.openResolving({source, sessionId: null, at});
      }
      await this.#requests.enqueueTicket({source, ticket: externalId, at});
    }

    for (const row of await this.#refreshes.active()) {
      if (row.state !== 'resolving') continue;
      if ((await this.#requests.openCount(row.source)) > 0) continue;
      if (row.pendingCursor !== null) {
        await this.#cursors.setCursor(row.source, row.pendingCursor);
      }
      await this.#requests.clear(row.source);
      await this.#refreshes.close(row.source, at);
    }
  }
}
```

- [ ] **Step 5: Write the barrel**

Create `plugins/dispatch/src/lib/refresh/index.mts`:

```ts
export * from './placeholders.mts';
export * from './refresh-service.mts';
```

- [ ] **Step 6: Run the tests**

Run: `node --test plugins/dispatch/src/lib/refresh/refresh-service.test.mts`
Expected: PASS (10 tests).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/dispatch/src/lib/refresh
git commit -m "feat: add RefreshService"
```

---

### Task 5: withDatabase and the shared --db option

**Files:**

- Create: `plugins/dispatch/src/lib/db/with-database.mts`
- Test: `plugins/dispatch/src/lib/db/with-database.test.mts`
- Modify: `plugins/dispatch/src/lib/db/index.mts`
- Modify: `plugins/dispatch/src/lib/db/CLAUDE.md`

**Interfaces:**

- Consumes: `Database`, the `Option` type from `../command/index.mts`.
- Produces: `DB_OPTION` (an `as const satisfies Option` literal — the literal types are required for `ParsedOptions` to resolve), `resolveDbPath(flag, env)`, `withDatabase(flag, env, body)`.

- [ ] **Step 1: Write the failing tests**

Create `plugins/dispatch/src/lib/db/with-database.test.mts`:

```ts
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {resolveDbPath, withDatabase} from './with-database.mts';

describe('resolveDbPath', () => {
  it('prefers the flag over the environment', () => {
    assert.equal(
      resolveDbPath('/flag.db', {DISPATCH_DB: '/env.db'}),
      '/flag.db'
    );
  });

  it('falls back to DISPATCH_DB, then the XDG state directory', () => {
    assert.equal(resolveDbPath(undefined, {DISPATCH_DB: '/env.db'}), '/env.db');
    assert.equal(
      resolveDbPath(undefined, {XDG_STATE_HOME: '/state'}),
      path.join('/state', 'dispatch', 'graph.db')
    );
  });
});

describe('withDatabase', () => {
  it('closes the handle even when the body throws', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-db-'));
    const file = path.join(dir, 'graph.db');
    await assert.rejects(
      withDatabase(file, {}, () => {
        throw new Error('boom');
      })
    );
    // A leaked handle would leave the file locked for the next opener.
    const rows = await withDatabase(file, {}, async (db) =>
      db.all('SELECT 1 AS one')
    );
    assert.equal(rows.length, 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/dispatch/src/lib/db/with-database.test.mts`
Expected: FAIL — cannot resolve `./with-database.mts`.

- [ ] **Step 3: Write the module**

Create `plugins/dispatch/src/lib/db/with-database.mts`:

```ts
import {homedir} from 'node:os';
import {join} from 'node:path';

import type {Option} from '../command/index.mts';
import {Database} from './database.mts';

/**
 * The `--db` flag every graph-writing command carries. Declared `as const
 * satisfies Option` rather than typed `Option`: `ParsedOptions` reads the
 * literal `type` to decide what `run` receives, and a widened type resolves to
 * `never`.
 */
export const DB_OPTION = {
  type: 'string',
  description:
    'Graph database path. Defaults to $DISPATCH_DB, else $XDG_STATE_HOME/dispatch/graph.db.',
  positional: false,
  required: false,
} as const satisfies Option;

export function resolveDbPath(
  flag: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  if (flag !== undefined && flag !== '') return flag;
  if (env.DISPATCH_DB !== undefined && env.DISPATCH_DB !== '')
    return env.DISPATCH_DB;
  const state =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ''
      ? env.XDG_STATE_HOME
      : join(homedir(), '.local', 'state');
  return join(state, 'dispatch', 'graph.db');
}

/**
 * Open the graph, run `body`, and close it even if `body` throws. Several
 * agents share one file, so a command that leaks its handle holds a lock the
 * next one has to wait out.
 */
export async function withDatabase<T>(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  body: (db: Database) => Promise<T> | T
): Promise<T> {
  const db = await Database.open(resolveDbPath(flag, env));
  try {
    return await body(db);
  } finally {
    await db.close();
  }
}
```

- [ ] **Step 4: Export and document**

Add to `plugins/dispatch/src/lib/db/index.mts`:

```ts
export * from './with-database.mts';
```

Add a bullet to `plugins/dispatch/src/lib/db/CLAUDE.md`:

```markdown
- `with-database.mts` — `withDatabase` (open/close around a command body),
  `resolveDbPath` (flag → `DISPATCH_DB` → XDG), and the shared `DB_OPTION`.
```

- [ ] **Step 5: Run the tests**

Run: `node --test plugins/dispatch/src/lib/db/with-database.test.mts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/dispatch/src/lib/db/with-database.mts plugins/dispatch/src/lib/db/with-database.test.mts plugins/dispatch/src/lib/db/index.mts plugins/dispatch/src/lib/db/CLAUDE.md
git commit -m "feat: add withDatabase and the shared --db option"
```

---

### Task 6: Project and milestone commands

**Files:**

- Create: `plugins/dispatch/src/lib/command/test-support.mts`
- Create: `plugins/dispatch/src/commands/project/set.mts`
- Create: `plugins/dispatch/src/commands/project/rm.mts`
- Create: `plugins/dispatch/src/commands/milestone/set.mts`
- Create: `plugins/dispatch/src/commands/milestone/rm.mts`
- Test: `plugins/dispatch/src/commands/project/set.test.mts`

**Interfaces:**

- Consumes: `DB_OPTION`, `withDatabase` (Task 5), `RefreshService` (Task 4), `ProjectStore`, `MilestoneStore`.
- Produces: `runCommand(command, parsed, env)` from `test-support.mts`, used by every later command test. The four commands write one line each: `project P`, `milestone M`, `removed project P`, `removed milestone M`.

- [ ] **Step 1: Write the test helper**

Create `plugins/dispatch/src/lib/command/test-support.mts` (not exported from the barrel — tests import it by path):

```ts
import {createLogger} from '../logger/index.mts';
import type {CoreLogger} from '../logger/index.mts';
import type {AbstractCommand} from './abstract-command.mts';
import {parseOptions} from './parse.mts';

const SILENT: CoreLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  log: () => {},
};

/**
 * Run a command the way a transport would, and return what it wrote to `io`.
 * `raw` goes through `parseOptions`, so defaults and `choices` apply exactly as
 * they would from argv or JSON — pass every value as a string except booleans.
 */
export async function runCommand(
  command: AbstractCommand,
  raw: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const parsed = parseOptions(command.options, raw);
  let captured = '';
  await command.run(parsed, {
    log: createLogger(SILENT),
    env,
    io: {
      write: (chunk) => {
        captured += chunk;
      },
    },
  });
  return captured;
}
```

- [ ] **Step 2: Write the failing test**

Create `plugins/dispatch/src/commands/project/set.test.mts`:

```ts
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {ProjectStore} from '../../lib/stores/index.mts';
import {Command} from './set.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('project set', () => {
  it('records the project with its tracker', async () => {
    const env = await tempEnv();
    const out = await runCommand(
      new Command(),
      {id: 'P', name: 'Proj', tracker: 'linear'},
      env
    );
    assert.equal(out, 'project P\n');
    const stored = await withDatabase(undefined, env, async (db) =>
      new ProjectStore(db).getProject('P')
    );
    assert.deepEqual(stored, {id: 'P', name: 'Proj', source: 'linear'});
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test plugins/dispatch/src/commands/project/set.test.mts`
Expected: FAIL — cannot resolve `./set.mts`.

- [ ] **Step 4: Write `project set`**

Create `plugins/dispatch/src/commands/project/set.mts`:

```ts
import {AbstractCommand} from '../../lib/command/index.mts';
import type {
  CommandContext,
  ParsedOptions,
} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {ProjectStore} from '../../lib/stores/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'Tracker identifier for the project.',
    positional: false,
    required: true,
  },
  name: {
    type: 'string',
    description: 'Human-readable project name.',
    positional: false,
    required: true,
  },
  tracker: {
    type: 'string',
    description:
      'Tracker the project lives on, e.g. linear. Every ticket in it inherits this.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary = 'Create or update one project.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: parsed.id,
        name: parsed.name,
        source: parsed.tracker,
      });
      await new RefreshService(db).reconcile();
      ctx.io.write(`project ${parsed.id}\n`);
    });
  }
}
```

- [ ] **Step 5: Run the test**

Run: `node --test plugins/dispatch/src/commands/project/set.test.mts`
Expected: PASS.

- [ ] **Step 6: Write the remaining three commands**

`plugins/dispatch/src/commands/project/rm.mts`:

```ts
import {AbstractCommand} from '../../lib/command/index.mts';
import type {
  CommandContext,
  ParsedOptions,
} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {ProjectStore} from '../../lib/stores/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'Tracker identifier for the project.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'rm';
  readonly summary = 'Delete one project.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const existed = await new ProjectStore(db).removeProject(parsed.id);
      await new RefreshService(db).reconcile();
      ctx.io.write(`removed project ${parsed.id} existed=${existed}\n`);
    });
  }
}
```

`plugins/dispatch/src/commands/milestone/set.mts` — same shape as `project/set.mts`, with:

```ts
const options = {
  id: {
    type: 'string',
    description: 'Tracker identifier for the milestone.',
    positional: false,
    required: true,
  },
  project: {
    type: 'string',
    description: 'Project the milestone belongs to.',
    positional: false,
    required: true,
  },
  name: {
    type: 'string',
    description: 'Human-readable milestone name.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;
```

and a body of:

```ts
    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new MilestoneStore(db).upsertMilestone({
        id: parsed.id,
        project: parsed.project,
        name: parsed.name,
      });
      await new RefreshService(db).reconcile();
      ctx.io.write(`milestone ${parsed.id}\n`);
    });
```

`plugins/dispatch/src/commands/milestone/rm.mts` — same shape as `project/rm.mts`, calling `removeMilestone` and writing `removed milestone ${parsed.id} existed=${existed}\n`.

- [ ] **Step 7: Verify discovery still loads the tree**

Run: `./plugins/dispatch/bin/dispatch project set --help` (or the CLI's usage path)
Expected: usage for `project set`, listing `--id`, `--name`, `--tracker`, `--db`. If the CLI has no `--help`, run `./plugins/dispatch/bin/dispatch` with no arguments and confirm `project` and `milestone` appear in the command list.

- [ ] **Step 8: Run the suite, lint, typecheck**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add plugins/dispatch/src/lib/command/test-support.mts plugins/dispatch/src/commands/project plugins/dispatch/src/commands/milestone
git commit -m "feat: add project and milestone commands"
```

---

### Task 7: Ticket commands

**Files:**

- Create: `plugins/dispatch/src/commands/ticket/set.mts`
- Create: `plugins/dispatch/src/commands/ticket/rm.mts`
- Create: `plugins/dispatch/src/commands/ticket/missing.mts`
- Test: `plugins/dispatch/src/commands/ticket/set.test.mts`
- Test: `plugins/dispatch/src/commands/ticket/missing.test.mts`

**Interfaces:**

- Consumes: `runCommand` (Task 6), `DB_OPTION`, `withDatabase`, `RefreshService`, `TicketStore`, `STATUSES` and `TARGET_KINDS` from `../../lib/model/status.mts`.
- Produces: `ticket set` writes `ticket <id>`; `ticket rm` writes `removed ticket <id> existed=<bool>`; `ticket missing` writes `missing ticket <id>`.

There is no `--milestone` flag: membership is a `ticket → milestone` edge written with `edge add`.

- [ ] **Step 1: Write the failing tests**

Create `plugins/dispatch/src/commands/ticket/set.test.mts`:

```ts
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {TicketStore} from '../../lib/stores/index.mts';
import {Command} from './set.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('ticket set', () => {
  it('records a ticket with its labels split and defaults applied', async () => {
    const env = await tempEnv();
    await runCommand(
      new Command(),
      {
        id: 'CLC-945',
        project: 'P',
        status: 'available',
        title: 'Do the thing',
        url: 'https://example.test/CLC-945',
        labels: 'infra,qa',
        'target-kind': 'pr',
      },
      env
    );
    const stored = await withDatabase(undefined, env, async (db) =>
      new TicketStore(db).getTicket('CLC-945')
    );
    assert.deepEqual(stored?.labels, ['infra', 'qa']);
    assert.equal(stored?.targetKind, 'pr');
    assert.equal(stored?.requiresHuman, false);
    assert.equal(stored?.priority, null);
  });
});
```

Create `plugins/dispatch/src/commands/ticket/missing.test.mts`:

```ts
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {UsageError} from '../../lib/errors/index.mts';
import {EdgeStore, ProjectStore, RefreshStore, TicketStore} from '../../lib/stores/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {Command} from './missing.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('ticket missing', () => {
  it('closes the refresh once the last requested id is reported missing', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket({
        id: 'T1',
        project: 'P',
        url: 'u',
        title: 'T1',
        status: 'available',
        targetKind: 'pr',
        requiresHuman: false,
        injected: false,
        priority: null,
        branchHint: null,
        labels: [],
        updatedAt: null,
      });
      await new EdgeStore(db).addEdge('GONE', 'T1');
      await new RefreshService(db).reconcile();
    });

    await runCommand(new Command(), {id: 'GONE'}, env);

    const state = await withDatabase(undefined, env, async (db) =>
      new RefreshStore(db).get('linear')
    );
    assert.equal(state?.state, 'idle');
  });

  it('refuses an id nobody asked for', async () => {
    const env = await tempEnv();
    await assert.rejects(
      runCommand(new Command(), {id: 'NOPE'}, env),
      (err: unknown) => err instanceof UsageError
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test plugins/dispatch/src/commands/ticket/set.test.mts plugins/dispatch/src/commands/ticket/missing.test.mts`
Expected: FAIL — cannot resolve `./set.mts` / `./missing.mts`.

- [ ] **Step 3: Write `ticket set`**

Create `plugins/dispatch/src/commands/ticket/set.mts`:

```ts
import {AbstractCommand} from '../../lib/command/index.mts';
import type {
  CommandContext,
  ParsedOptions,
} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {STATUSES, TARGET_KINDS} from '../../lib/model/status.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {TicketStore} from '../../lib/stores/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'Tracker identifier, e.g. CLC-945.',
    positional: false,
    required: true,
  },
  project: {
    type: 'string',
    description: 'Project the ticket belongs to.',
    positional: false,
    required: true,
  },
  status: {
    type: 'string',
    description: 'Normalized lifecycle status; map the tracker state yourself.',
    positional: false,
    required: true,
    choices: STATUSES,
  },
  title: {
    type: 'string',
    description: 'Ticket title.',
    positional: false,
    required: false,
    default: '',
  },
  url: {
    type: 'string',
    description: 'Ticket URL.',
    positional: false,
    required: false,
    default: '',
  },
  'target-kind': {
    type: 'string',
    description: 'What finishing this ticket produces.',
    positional: false,
    required: false,
    default: 'pr',
    choices: TARGET_KINDS,
  },
  'requires-human': {
    type: 'boolean',
    description: 'Only a human may work this ticket.',
    positional: false,
    required: false,
  },
  injected: {
    type: 'boolean',
    description: 'Rank this ticket to the top of the frontier.',
    positional: false,
    required: false,
  },
  priority: {
    type: 'number',
    description: 'Lower is more urgent; omit if the tracker has none.',
    positional: false,
    required: false,
  },
  labels: {
    type: 'string',
    description: 'Comma-separated tracker labels, passed through as-is.',
    positional: false,
    required: false,
    default: '',
  },
  'branch-hint': {
    type: 'string',
    description: 'Branch-name seed the tracker suggests.',
    positional: false,
    required: false,
  },
  'updated-at': {
    type: 'string',
    description: 'When the tracker last saw the ticket move (RFC 3339).',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary = 'Create or update one ticket.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const labels = parsed.labels
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label !== '');

    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new TicketStore(db).upsertTicket({
        id: parsed.id,
        project: parsed.project,
        url: parsed.url,
        title: parsed.title,
        status: parsed.status,
        targetKind: parsed['target-kind'],
        requiresHuman: parsed['requires-human'],
        injected: parsed.injected,
        priority: parsed.priority ?? null,
        branchHint: parsed['branch-hint'] ?? null,
        labels,
        updatedAt: parsed['updated-at'] ?? null,
      });
      await new RefreshService(db).reconcile();
      ctx.io.write(`ticket ${parsed.id}\n`);
    });
  }
}
```

- [ ] **Step 4: Write `ticket rm` and `ticket missing`**

`plugins/dispatch/src/commands/ticket/rm.mts` — the shape of `project/rm.mts`, calling `new TicketStore(db).removeTicket(parsed.id)` and writing `removed ticket ${parsed.id} existed=${existed}\n`.

`plugins/dispatch/src/commands/ticket/missing.mts`:

```ts
import {AbstractCommand} from '../../lib/command/index.mts';
import type {
  CommandContext,
  ParsedOptions,
} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'The ticket id the tracker has no record of.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'missing';
  readonly summary = 'Report that a requested ticket does not exist.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new RefreshService(db).markMissing(parsed.id);
      ctx.io.write(`missing ticket ${parsed.id}\n`);
    });
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test plugins/dispatch/src/commands/ticket/set.test.mts plugins/dispatch/src/commands/ticket/missing.test.mts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/dispatch/src/commands/ticket
git commit -m "feat: add ticket commands"
```

---

### Task 8: Edge commands

**Files:**

- Create: `plugins/dispatch/src/commands/edge/add.mts`
- Create: `plugins/dispatch/src/commands/edge/rm.mts`
- Create: `plugins/dispatch/src/commands/edge/set.mts`
- Test: `plugins/dispatch/src/commands/edge/set.test.mts`

**Interfaces:**

- Consumes: `runCommand`, `DB_OPTION`, `withDatabase`, `RefreshService`, `EdgeStore`.
- Produces: `edge add` writes `edge <blocker> -> <blocked> added=<bool>`; `edge rm` writes `removed edge <blocker> -> <blocked> existed=<bool>`; `edge set` writes `edges of <node> (<direction>) = <comma list>`.

- [ ] **Step 1: Write the failing test**

Create `plugins/dispatch/src/commands/edge/set.test.mts`:

```ts
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {DataError} from '../../lib/errors/index.mts';
import {EdgeStore} from '../../lib/stores/index.mts';
import {Command as AddCommand} from './add.mts';
import {Command as SetCommand} from './set.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('edge set', () => {
  it('replaces every blocker of a node in one call', async () => {
    const env = await tempEnv();
    await runCommand(new AddCommand(), {blocker: 'OLD', blocked: 'N'}, env);
    await runCommand(
      new SetCommand(),
      {node: 'N', direction: 'blockers', others: 'A,B'},
      env
    );
    const blockers = (
      await withDatabase(undefined, env, async (db) =>
        new EdgeStore(db).edges()
      )
    )
      .filter((edge) => edge.blocked === 'N')
      .map((edge) => edge.blocker)
      .sort();
    assert.deepEqual(blockers, ['A', 'B']);
  });
});

describe('edge add', () => {
  it('refuses an edge that would close a cycle', async () => {
    const env = await tempEnv();
    await runCommand(new AddCommand(), {blocker: 'A', blocked: 'B'}, env);
    await assert.rejects(
      runCommand(new AddCommand(), {blocker: 'B', blocked: 'A'}, env),
      (err: unknown) => err instanceof DataError
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/dispatch/src/commands/edge/set.test.mts`
Expected: FAIL — cannot resolve `./add.mts`.

- [ ] **Step 3: Write the three commands**

`plugins/dispatch/src/commands/edge/add.mts`:

```ts
import {AbstractCommand} from '../../lib/command/index.mts';
import type {
  CommandContext,
  ParsedOptions,
} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {EdgeStore} from '../../lib/stores/index.mts';

const options = {
  blocker: {
    type: 'string',
    description: 'The node that must resolve first.',
    positional: false,
    required: true,
  },
  blocked: {
    type: 'string',
    description: 'The node that waits on it.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'add';
  readonly summary = 'Record that one node blocks another.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const added = await new EdgeStore(db).addEdge(
        parsed.blocker,
        parsed.blocked
      );
      await new RefreshService(db).reconcile();
      ctx.io.write(
        `edge ${parsed.blocker} -> ${parsed.blocked} added=${added}\n`
      );
    });
  }
}
```

`plugins/dispatch/src/commands/edge/rm.mts` — same options, calling `removeEdge` and writing `removed edge ${parsed.blocker} -> ${parsed.blocked} existed=${existed}\n`.

`plugins/dispatch/src/commands/edge/set.mts`:

```ts
import {AbstractCommand} from '../../lib/command/index.mts';
import type {
  CommandContext,
  ParsedOptions,
} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {EdgeStore} from '../../lib/stores/index.mts';

const options = {
  node: {
    type: 'string',
    description: 'The node whose edges are being redeclared.',
    positional: false,
    required: true,
  },
  direction: {
    type: 'string',
    description: 'Which side to replace.',
    positional: false,
    required: true,
    choices: ['blockers', 'blocks'],
  },
  others: {
    type: 'string',
    description: 'Comma-separated node ids; empty clears the direction.',
    positional: false,
    required: false,
    default: '',
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary = 'Replace every edge on one side of a node.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const others = parsed.others
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');

    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new EdgeStore(db).setEdges(parsed.node, parsed.direction, others);
      await new RefreshService(db).reconcile();
      ctx.io.write(
        `edges of ${parsed.node} (${parsed.direction}) = ${others.join(',')}\n`
      );
    });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test plugins/dispatch/src/commands/edge/set.test.mts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/commands/edge
git commit -m "feat: add edge commands"
```

---

### Task 9: Refresh commands

**Files:**

- Create: `plugins/dispatch/src/commands/refresh.mts`
- Create: `plugins/dispatch/src/commands/refresh/done.mts`
- Create: `plugins/dispatch/src/commands/refresh/status.mts`
- Test: `plugins/dispatch/src/commands/refresh.test.mts`

**Interfaces:**

- Consumes: `runCommand`, `DB_OPTION`, `withDatabase`, `RefreshService`.
- Produces: `dispatch refresh` writes `refresh <tracker> opened` or `refresh <tracker> resumed`; `refresh done` writes `refresh <tracker> <state>` plus one `pending <id>` line per outstanding id; `refresh status` writes the state line plus one line per request.

`refresh.mts` sits beside the `refresh/` directory, which makes `refresh` both runnable and a namespace.

- [ ] **Step 1: Write the failing test**

Create `plugins/dispatch/src/commands/refresh.test.mts`:

```ts
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../lib/command/test-support.mts';
import {withDatabase} from '../lib/db/index.mts';
import {FetchRequestStore} from '../lib/stores/index.mts';
import {Command as RefreshCommand} from './refresh.mts';
import {Command as DoneCommand} from './refresh/done.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('refresh', () => {
  it('opens a refresh and queues one scan', async () => {
    const env = await tempEnv();
    const out = await runCommand(
      new RefreshCommand(),
      {tracker: 'linear', project: 'P1,P2'},
      env
    );
    assert.equal(out, 'refresh linear opened\n');
    const queued = await withDatabase(undefined, env, async (db) =>
      new FetchRequestStore(db).undelivered()
    );
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].payload, {
      projects: ['P1', 'P2'],
      cursor: null,
    });
  });

  it('done on an empty graph closes the refresh', async () => {
    const env = await tempEnv();
    await runCommand(new RefreshCommand(), {tracker: 'linear', project: 'P'}, env);
    const out = await runCommand(
      new DoneCommand(),
      {tracker: 'linear', cursor: 'tok'},
      env
    );
    assert.equal(out, 'refresh linear idle\n');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/dispatch/src/commands/refresh.test.mts`
Expected: FAIL — cannot resolve `./refresh.mts`.

- [ ] **Step 3: Write `refresh`**

Create `plugins/dispatch/src/commands/refresh.mts`:

```ts
import {AbstractCommand} from '../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../lib/db/index.mts';
import {RefreshService} from '../lib/refresh/index.mts';

const options = {
  tracker: {
    type: 'string',
    description: 'Tracker to refresh, e.g. linear.',
    positional: false,
    required: true,
  },
  project: {
    type: 'string',
    description: 'Comma-separated project ids to scan.',
    positional: false,
    required: true,
  },
  rebuild: {
    type: 'boolean',
    description: 'Drop the graph and scan from scratch, ignoring the cursor.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'refresh';
  readonly summary = 'Start or resume building the project graph for a tracker.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const projects = parsed.project
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');

    await withDatabase(parsed.db, ctx.env, async (db) => {
      const {resumed} = await new RefreshService(db).startScan({
        source: parsed.tracker,
        projects,
        sessionId: ctx.env.CLAUDE_CODE_SESSION_ID ?? null,
        rebuild: parsed.rebuild,
      });
      ctx.io.write(
        `refresh ${parsed.tracker} ${resumed ? 'resumed' : 'opened'}\n`
      );
    });
  }
}
```

- [ ] **Step 4: Write `refresh done` and `refresh status`**

`plugins/dispatch/src/commands/refresh/done.mts`:

```ts
import {AbstractCommand} from '../../lib/command/index.mts';
import type {
  CommandContext,
  ParsedOptions,
} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';

const options = {
  tracker: {
    type: 'string',
    description: 'Tracker whose scan is complete.',
    positional: false,
    required: true,
  },
  cursor: {
    type: 'string',
    description:
      'Opaque tracker token marking how far this scan read. Recorded only when the refresh closes.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'done';
  readonly summary = 'Report that everything the scan found has been written.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const {state, pending} = await new RefreshService(db).completeScan({
        source: parsed.tracker,
        cursor: parsed.cursor ?? null,
      });
      ctx.io.write(`refresh ${parsed.tracker} ${state}\n`);
      for (const id of pending) ctx.io.write(`pending ${id}\n`);
    });
  }
}
```

`plugins/dispatch/src/commands/refresh/status.mts`:

```ts
import {AbstractCommand} from '../../lib/command/index.mts';
import type {
  CommandContext,
  ParsedOptions,
} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';

const options = {
  tracker: {
    type: 'string',
    description: 'Tracker to report on.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'status';
  readonly summary = 'Print the refresh state and every outstanding instruction.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const {refresh, requests} = await new RefreshService(db).status(
        parsed.tracker
      );
      ctx.io.write(`refresh ${parsed.tracker} ${refresh?.state ?? 'none'}\n`);
      for (const request of requests) {
        if (request.resolution !== null) continue;
        ctx.io.write(
          `${request.kind} ${JSON.stringify(request.payload)} delivered=${request.deliveredAt !== null}\n`
        );
      }
    });
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test plugins/dispatch/src/commands/refresh.test.mts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/dispatch/src/commands/refresh.mts plugins/dispatch/src/commands/refresh plugins/dispatch/src/commands/refresh.test.mts
git commit -m "feat: add refresh commands"
```

---

### Task 10: Channel push

**Files:**

- Create: `plugins/dispatch/src/lib/mcp/channel.mts`
- Create: `plugins/dispatch/src/lib/mcp/drain.mts`
- Test: `plugins/dispatch/src/lib/mcp/drain.test.mts`
- Modify: `plugins/dispatch/src/lib/mcp/mcp.mts`
- Modify: `plugins/dispatch/src/lib/mcp/mcp.test.mts`
- Modify: `plugins/dispatch/src/lib/mcp/index.mts`
- Modify: `plugins/dispatch/src/lib/mcp/CLAUDE.md`

**Interfaces:**

- Consumes: `RefreshStore`, `FetchRequestStore`, `withDatabase`, `nowIso`.
- Produces:

```ts
export class ChannelWriter {
  constructor(emit: (payload: unknown) => void);
  push(kind: string, meta: Readonly<Record<string, string | null>>, content: string): void;
}
export function drainInstructions(channel: ChannelWriter, env: NodeJS.ProcessEnv, now?: () => string): Promise<number>;
```

`push` drops any meta key that is null or fails `^[a-zA-Z_][a-zA-Z0-9_]*$`, refuses a `source` key (the runner sets that one), and stamps `kind` and a monotonic `seq`.

- [ ] **Step 1: Write the failing test**

Create `plugins/dispatch/src/lib/mcp/drain.test.mts`:

```ts
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {withDatabase} from '../db/index.mts';
import {RefreshService} from '../refresh/index.mts';
import {ChannelWriter} from './channel.mts';
import {drainInstructions} from './drain.mts';

interface Notification {
  method: string;
  params: {content: string; meta: Record<string, string>};
}

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-drain-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('drainInstructions', () => {
  it('pushes one notification per undelivered row, with increasing seq', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new RefreshService(db).startScan({
        source: 'linear',
        projects: ['P'],
        sessionId: null,
        rebuild: false,
      });
    });

    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );

    assert.equal(await drainInstructions(channel, env), 1);
    assert.equal(await drainInstructions(channel, env), 0);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'notifications/claude/channel');
    assert.equal(sent[0].params.meta.kind, 'scan_project');
    assert.equal(sent[0].params.meta.seq, '1');
    assert.equal(sent[0].params.meta.source, undefined);
  });

  it('pushes the completion event exactly once', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      const service = new RefreshService(db);
      await service.startScan({
        source: 'linear',
        projects: ['P'],
        sessionId: null,
        rebuild: false,
      });
      await service.completeScan({source: 'linear', cursor: 'tok'});
    });

    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );
    await drainInstructions(channel, env);
    await drainInstructions(channel, env);

    const kinds = sent.map((n) => n.params.meta.kind);
    assert.equal(kinds.filter((k) => k === 'refresh_complete').length, 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/dispatch/src/lib/mcp/drain.test.mts`
Expected: FAIL — cannot resolve `./channel.mts`.

- [ ] **Step 3: Write the channel writer**

Create `plugins/dispatch/src/lib/mcp/channel.mts`:

```ts
/** The runner drops any meta key outside this shape. */
const META_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

/**
 * Pushes channel events into the session that spawned the server. `source` is
 * the runner's own attribute — a second one on the tag would not override it,
 * so this never sets one.
 */
export class ChannelWriter {
  readonly #emit: (payload: unknown) => void;
  #seq = 0;

  constructor(emit: (payload: unknown) => void) {
    this.#emit = emit;
  }

  push(
    kind: string,
    meta: Readonly<Record<string, string | null>>,
    content: string
  ): void {
    this.#seq += 1;
    const params: Record<string, string> = {kind, seq: String(this.#seq)};
    for (const [key, value] of Object.entries(meta)) {
      if (value === null) continue;
      if (key === 'source' || key === 'kind' || key === 'seq') continue;
      if (!META_KEY.test(key)) continue;
      params[key] = value;
    }
    this.#emit({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: {content, meta: params},
    });
  }
}
```

- [ ] **Step 4: Write the drain**

Create `plugins/dispatch/src/lib/mcp/drain.mts`:

```ts
import {nowIso} from '../db/time.mts';
import {withDatabase} from '../db/index.mts';
import {FetchRequestStore, RefreshStore} from '../stores/index.mts';
import type {ScanPayload, TicketPayload} from '../stores/index.mts';
import type {ChannelWriter} from './channel.mts';

/**
 * Push every instruction the graph owes the session, then every completion.
 * Returns how many events went out. Delivery is recorded in the database, so a
 * restart re-derives what is still owed rather than assuming a push landed.
 */
export async function drainInstructions(
  channel: ChannelWriter,
  env: NodeJS.ProcessEnv,
  now: () => string = nowIso
): Promise<number> {
  return withDatabase(undefined, env, async (db) => {
    const requests = new FetchRequestStore(db);
    const refreshes = new RefreshStore(db);
    const at = now();
    let sent = 0;

    for (const request of await requests.undelivered()) {
      if (request.kind === 'scan_project') {
        const payload = request.payload as ScanPayload;
        channel.push(
          'scan_project',
          {
            tracker: request.source,
            projects: payload.projects.join(','),
            cursor: payload.cursor,
          },
          scanBody(request.source, payload)
        );
      } else {
        const {ticket} = request.payload as TicketPayload;
        channel.push(
          'fetch_ticket',
          {tracker: request.source, ticket},
          ticketBody(request.source, ticket)
        );
      }
      await requests.markDelivered(request.id, at);
      sent += 1;
    }

    for (const source of await refreshes.pendingCompletions()) {
      channel.push(
        'refresh_complete',
        {tracker: source},
        `The ${source} project graph is complete. Stop fetching and report it built.`
      );
      await refreshes.markCompletionEmitted(source, at);
      sent += 1;
    }

    return sent;
  });
}

function scanBody(source: string, payload: ScanPayload): string {
  const since =
    payload.cursor === null ? '' : ` updated since ${payload.cursor}`;
  return [
    `Scan every ticket in ${payload.projects.join(', ')} on ${source}${since}.`,
    'Record each project, milestone, ticket, and dependency with the dispatch',
    `commands, then run: dispatch refresh done --tracker ${source} --cursor <token>`,
  ].join(' ');
}

function ticketBody(source: string, ticket: string): string {
  return [
    `Fetch ticket ${ticket} from ${source} and record it with dispatch ticket set.`,
    `If ${source} has no such ticket, run: dispatch ticket missing --id ${ticket}`,
  ].join(' ');
}
```

- [ ] **Step 5: Run the drain tests**

Run: `node --test plugins/dispatch/src/lib/mcp/drain.test.mts`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire the server**

In `plugins/dispatch/src/lib/mcp/mcp.mts`:

Add imports:

```ts
import {ChannelWriter} from './channel.mts';
import {drainInstructions} from './drain.mts';
```

Declare the capability in the `initialize` case:

```ts
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {tools: {}, experimental: {'claude/channel': {}}},
        serverInfo: SERVER_INFO,
      };
```

Change `handleLine` to report whether it ran a tool. Its two `return errorResponse(...)`/`return {jsonrpc...}` sites become `{response, ranTool}`:

```ts
interface Handled {
  readonly response: unknown | undefined;
  readonly ranTool: boolean;
}
```

Every existing `return X;` in `handleLine` becomes `return {response: X, ranTool};`, every `return undefined;` becomes `return {response: undefined, ranTool};`, and `ranTool` is computed right after parsing:

```ts
  const ranTool = request.method === 'tools/call';
```

(place it after the `request` assignment; the parse-error path returns `{response: errorResponse(...), ranTool: false}`).

Then in the read loop:

```ts
  const channel = new ChannelWriter((payload) => {
    opts.stdout.write(`${JSON.stringify(payload)}\n`);
  });

  const rl = readline.createInterface({input: opts.stdin, crlfDelay: Infinity});
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const {response, ranTool} = await handleLine(line, ctx);
    if (response !== undefined)
      opts.stdout.write(`${JSON.stringify(response)}\n`);
    if (ranTool) await drainInstructions(channel, opts.env);
  }
```

- [ ] **Step 7: Give the existing MCP tests a database**

The drain now opens the graph after every tool call, so `mcp.test.mts` must not fall through to the real XDG path. In `plugins/dispatch/src/lib/mcp/mcp.test.mts`, change `serve` to default `env` to a temp database:

```ts
async function serve(
  stdin: Readable,
  env?: NodeJS.ProcessEnv
): Promise<RpcLine[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-mcp-'));
  const resolved = {DISPATCH_DB: path.join(dir, 'graph.db'), ...env};
  // ... unchanged body, passing `resolved` to runMcpServer
}
```

Add the imports it needs:

```ts
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
```

Any test that asserts on the exact parsed lines must now tolerate notification lines (they have no `id`). Filter them out where a test indexes into the result:

```ts
  .filter((line) => line.id !== undefined)
```

- [ ] **Step 8: Export and document**

Add to `plugins/dispatch/src/lib/mcp/index.mts`:

```ts
export * from './channel.mts';
export * from './drain.mts';
```

Add to `plugins/dispatch/src/lib/mcp/CLAUDE.md`:

```markdown
- `channel.mts` — `ChannelWriter` frames `notifications/claude/channel` events:
  monotonic `seq`, meta keys filtered to `^[a-zA-Z_][a-zA-Z0-9_]*$`, never a
  `source` key (the runner sets that one).
- `drain.mts` — `drainInstructions` turns undelivered `fetch_request` rows and
  owed completions into events, and records delivery in the database.
```

- [ ] **Step 9: Run the suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add plugins/dispatch/src/lib/mcp
git commit -m "feat: push graph fetch instructions over the channel"
```

---

### Task 11: Skills, slash command, and version bump

**Files:**

- Create: `plugins/dispatch/commands/orchestrate.md`
- Rewrite: `plugins/dispatch/skills/orchestrate/SKILL.md`
- Rewrite: `plugins/dispatch/skills/build-graph/SKILL.md`
- Rewrite: `plugins/dispatch/skills/build-graph/reference.md`
- Modify: `plugins/dispatch/.claude-plugin/plugin.json`

**Interfaces:**

- Consumes: every command from Tasks 6–9, and the three channel event kinds from Task 10 (`scan_project`, `fetch_ticket`, `refresh_complete`).
- Produces: nothing code depends on.

- [ ] **Step 1: Write the slash command**

Create `plugins/dispatch/commands/orchestrate.md`:

```markdown
---
description: Build a tracker project's dependency graph and report it.
argument-hint: <project name or id>
---

Use the `orchestrate` skill to build the project graph for: $ARGUMENTS
```

- [ ] **Step 2: Rewrite the orchestrate skill**

Replace `plugins/dispatch/skills/orchestrate/SKILL.md` with:

````markdown
---
name: orchestrate
description: Build a tracker project's dependency graph — start a refresh, then answer the CLI's fetch instructions until it reports the graph complete. Use when asked to orchestrate, plan, or graph a whole project rather than one ticket.
---

# orchestrate

**The CLI decides what to fetch. You fetch it.** Never work out which tickets
are missing, whether a scan is complete, or what to do next — the CLI tells you
in an instruction, and you answer it.

## Start

1. Resolve the project the operator named to its tracker id. Load
   `tracker-adapter-${user_config.tracker}` and use its lookup; without an
   adapter, drive the tracker's MCP server directly.
2. Run `dispatch refresh --tracker <id> --project <project-ids>`.
3. It answers with an ack. Stop and wait — the work arrives as instructions.

Add `--rebuild` only when the operator asks for a rebuild from scratch.

## Answering instructions

Each instruction arrives in the session as its own turn.

| Instruction        | Do this                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `scan_project`     | Run [`build-graph`](../build-graph/SKILL.md) for the projects and cursor named. |
| `fetch_ticket`     | Run [`build-graph`](../build-graph/SKILL.md) for the single ticket named.       |
| `refresh_complete` | Stop. Report the graph is built, with the project ids and a ticket count. |

Nothing else ends the run. An empty frontier, a quiet stretch, or a scan that
found no tickets are not completion — only `refresh_complete` is.

## If nothing arrives

The instructions ride the channel, so a session whose runner did not register
it hears nothing. Run `dispatch refresh status --tracker <id>` — it prints the
state and every outstanding instruction. Answer them the same way, then run it
again until the state is `idle`.
````

- [ ] **Step 3: Rewrite the build-graph skill**

Replace `plugins/dispatch/skills/build-graph/SKILL.md` with:

````markdown
---
name: build-graph
description: Answer one project-graph fetch instruction — scan a project's tickets, or fetch one ticket, and record what you find through the dispatch CLI. Use when a scan_project or fetch_ticket instruction arrives.
---

# build-graph

You handle **one instruction**. Fetch what it names, write what you find, and
stop. Do not decide what to fetch next, chase a dependency you noticed, or judge
whether the graph is complete — the CLI does all three and will send another
instruction if it needs one.

## The adapter

Read `tracker-adapter-${user_config.tracker}` first: it supplies the tools, the
field mapping, and the tracker's state → status table. A project on a different
tracker loads `tracker-adapter-<id>` for that tracker. Without an adapter, drive
the tracker's MCP server directly and map its fields onto the flags below
yourself.

## `scan_project`

Fetch every ticket in the named projects. When the instruction carries a cursor,
fetch only what changed since it. Do not filter further — a ticket you skip
becomes a placeholder the CLI has to ask for one at a time.

Write as you go, one command per item so a bad one fails only itself:

```shell
dispatch project set   --id P --name "Platform" --tracker linear
dispatch milestone set --id M1 --project P --name "M1"
dispatch ticket set    --id CLC-945 --project P --status in-progress \
    --title "…" --url "…" [--priority 2] [--labels infra,qa]
dispatch edge add      --blocker CLC-944 --blocked CLC-945
```

Then report the scan complete, passing the tracker's own change token:

```shell
dispatch refresh done --tracker linear --cursor <token>
```

## `fetch_ticket`

Fetch the one ticket named and write it with `ticket set`. If the tracker has no
such ticket — deleted, or on a different tracker — say so instead:

```shell
dispatch ticket missing --id CLC-944
```

Never guess a ticket into existence to clear an instruction.

## Writing rules

- **You map the state; the CLI knows only the vocabulary.** `--status` takes
  `backlog`, `paused`, `awaiting-external`, `available`, `in-progress`,
  `in-review`, `finished`, `delivered`, `verified`, or `canceled`. The adapter
  carries the tracker's table and the rule for a state it does not cover: map it
  only when the lifecycle meaning is unambiguous, otherwise ask the operator.
  Never guess.
- **A milestone is joined by an edge.** `edge add --blocker CLC-945 --blocked M1`
  puts CLC-945 in milestone M1. Milestones are sequenced the same way:
  `edge add --blocker M1 --blocked M2` means M2's work waits on M1.
- **Redeclare a direction with `edge set`.** After re-fetching a ticket's
  blockers, `edge set --node CLC-945 --direction blockers --others a,b` makes
  them exactly `{a,b}` (empty clears them). Use it instead of diffing.
- **An edge that would close a cycle is refused.** Fix the direction, or remove
  the opposing edge first.
- **A delta writes only what changed.** A ticket you don't touch keeps its state.
  Use `ticket rm` only when the fetch shows it gone.

Full flags: [`reference.md`](./reference.md).
````

- [ ] **Step 4: Rewrite the reference**

Replace `plugins/dispatch/skills/build-graph/reference.md` with one flag table per command — `project set/rm`, `milestone set/rm`, `ticket set/rm/missing`, `edge add/rm/set`, `refresh`, `refresh done`, `refresh status` — each row copied from that command's `options` block in Tasks 6–9. One row per option: the flag, `yes`/`no` for required, the `description` string verbatim, and any `choices` inline. For example, `ticket set` starts:

```markdown
## `dispatch ticket set`

| Flag           | Required | Meaning                                                            |
| -------------- | -------- | ------------------------------------------------------------------ |
| `--id`         | yes      | Tracker identifier, e.g. CLC-945.                                  |
| `--project`    | yes      | Project the ticket belongs to.                                     |
| `--status`     | yes      | Normalized lifecycle status; map the tracker state yourself. One of: backlog, paused, awaiting-external, available, in-progress, in-review, finished, delivered, verified, canceled. |
| `--title`      | no       | Ticket title.                                                      |
```

Close with an exit-code table: read `plugins/dispatch/src/lib/errors/` and list each error class's `exitCode` with one line on what makes the CLI throw it. No section may cite a spec section number.

- [ ] **Step 5: Bump the plugin version**

In `plugins/dispatch/.claude-plugin/plugin.json`, change `"version": "0.16.0"` to `"version": "0.17.0"`.

- [ ] **Step 6: Validate**

Run: `claude plugin validate .`
Expected: no errors.

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/dispatch/commands plugins/dispatch/skills plugins/dispatch/.claude-plugin/plugin.json
git commit -m "feat: drive graph ingest from channel instructions"
```

---

## Self-review notes

Spec coverage checked section by section: command surface (Tasks 6–9), refresh
state machine and its `idle`/`scanning`/`resolving` rules (Task 4), ids that
resolve to nothing (Tasks 4 and 7), instructions and the channel including all
three event kinds (Task 10), plumbing (Tasks 1–5), errors (Tasks 4, 7, 8), and
both skills (Task 11). Every testing bullet in the design maps to a named test.

One design item is deliberately not a separate task: `graph reset` folded into
`refresh --rebuild`, implemented inside `RefreshService.startScan` and tested by
the "rebuild drops the graph and scans with no cursor" case in Task 4.
