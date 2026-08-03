# Persistence foundation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SQLite storage foundation for the rewritten Dispatch CLI — schema, connection support code, domain models, per-concept write stores, and the session/claim/slot/outcome coordination layer.

**Architecture:** One base `node` identity table with per-kind satellites (`project`/`milestone`/`ticket`/`pr`), a single untyped blocking `edge` relation, and session-scoped coordination rows (`claim`/`slot`/`outcome`) that cascade off a `session` on clean exit or a staleness sweep. Access is organized around concepts: `lib/db` holds the low-level connection, `lib/model` holds pure types + enums, `lib/stores` holds one store per concept. This plan covers everything except the derived read-model (frontier/classification/anomalies) and `recordReview`, which are Plan 2.

**Tech Stack:** TypeScript `.mts` run unbuilt on Node native type stripping; `node:sqlite`; `node:test` for tests. No runtime dependencies.

## Global Constraints

- **File layout:** `.mts` everywhere. Import sibling modules by real path with extension (`./database.mts`). One exported class per file. Keep files under ~200 lines.
- **Async facade:** `node:sqlite` is synchronous; store/`Database` methods are `async` anyway so an async driver later is a change behind the facade. (ESLint `@typescript-eslint/require-await` must be disabled per-file with the same comment the old code used — see Task 3.)
- **Errors:** invalid caller data (bad enum, dependency cycle, id used as two kinds) throws `DataError` with a `hint`; a locked/unwritable DB throws `EnvironmentError`. Validate enums in code *before* the SQL write — a raw SQLite CHECK failure would be caught by `guard()` and mislabeled as an `EnvironmentError`. Build taxonomy errors lazily via `ensure(cond, () => new DataError(...))` from `lib/errors`.
- **Timestamps:** TEXT ISO-8601 UTC (`2026-07-31T12:00:00.000Z`). Validate RFC 3339 shape before storing. Stores take timestamps as explicit string params (never call the clock internally) so tests are deterministic.
- **SQLite:** `STRICT` tables; `PRAGMA foreign_keys = ON` (the cascade cleanup is inert without it). Booleans stored as `0`/`1`. JSON arrays (`labels`) stored as TEXT, read/written whole.
- **Tests:** `node:test` (`describe`/`it`), `assert from 'node:assert/strict'`. Test behaviors, not lines. Use a fresh `:memory:` `Database` per test. Single file: `node --test <path>`. Full suite: `npm test`. Also `npm run typecheck` and `npm run lint` before finishing.
- **Commits:** conventional-commit messages, no `Co-Authored-By` trailer. (Environment note: if the pre-commit hook fails on an `EPERM` npm-cache error, that's a broken `~/.npm` — fix with `sudo chown -R 501:20 ~/.npm`; commit signing needs the gpg-agent reachable.)
- **Paths:** all files below are under `plugins/dispatch/src/`.

---

### Task 1: DataError taxonomy class

**Files:**
- Create: `plugins/dispatch/src/lib/errors/data-error.mts`
- Modify: `plugins/dispatch/src/lib/errors/index.mts`
- Test: `plugins/dispatch/src/lib/errors/data-error.test.mts`

**Interfaces:**
- Consumes: `CommandError` from `./command-error.mts`.
- Produces: `DataError extends CommandError` with `exitCode = 4`, used by every store for invalid-data failures.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError} from './data-error.mts';
import {CommandError, DispatchError} from './index.mts';

describe('DataError', () => {
  it('is a CommandError with exit code 4 and renders its hint', () => {
    const err = new DataError('that edge would create a cycle', {
      hint: 'remove the opposing edge first.',
    });
    assert.ok(err instanceof CommandError);
    assert.ok(err instanceof DispatchError);
    assert.equal(err.exitCode, 4);
    assert.equal(err.name, 'DataError');
    assert.match(err.toString(), /hint: remove the opposing edge first\./u);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/errors/data-error.test.mts`
Expected: FAIL — cannot find `./data-error.mts`.

- [ ] **Step 3: Write minimal implementation**

`data-error.mts`:

```ts
import {CommandError} from './command-error.mts';

/**
 * The caller's input was well-formed but describes invalid data: a dependency
 * cycle, an id used as two kinds, an unknown status. Distinct from `UsageError`
 * (a malformed invocation) so a caller can branch on "fix the data" vs "fix the
 * command line".
 */
export class DataError extends CommandError {
  override readonly name: string = 'DataError';
  override readonly exitCode = 4;
}
```

Add to `index.mts` after the `command-error` export line:

```ts
export * from './data-error.mts';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/errors/data-error.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/errors/
git commit -m "feat: add DataError for invalid-data failures"
```

---

### Task 2: Timestamp support

**Files:**
- Create: `plugins/dispatch/src/lib/db/time.mts`
- Test: `plugins/dispatch/src/lib/db/time.test.mts`

**Interfaces:**
- Consumes: `DataError`, `ensure` from `../errors/index.mts`.
- Produces: `nowIso(): string` and `assertInstant(value: string, field: string): void`, used by callers to stamp and by stores to validate timestamps.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError} from '../errors/index.mts';
import {assertInstant, nowIso} from './time.mts';

describe('nowIso', () => {
  it('returns a Zulu ISO-8601 instant', () => {
    assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });
});

describe('assertInstant', () => {
  it('accepts an RFC 3339 instant', () => {
    assert.doesNotThrow(() => {
      assertInstant('2026-07-31T12:00:00.000Z', '--at');
    });
  });

  it('rejects a non-timestamp with a DataError naming the field', () => {
    assert.throws(
      () => {
        assertInstant('07/31/2026', '--at');
      },
      (err: unknown) => err instanceof DataError && /--at/u.test(err.message)
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/db/time.test.mts`
Expected: FAIL — cannot find `./time.mts`.

- [ ] **Step 3: Write minimal implementation**

`time.mts`:

```ts
import {DataError, ensure} from '../errors/index.mts';

/**
 * RFC 3339 shape, checked before Date.parse: V8 also accepts local formats like
 * "07/31/2026", which would record an instant the caller never meant.
 */
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;

/** The current instant as a Zulu ISO-8601 string — what callers stamp rows with. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Reject a timestamp that is not RFC 3339, where the fix is naming the field. */
export function assertInstant(value: string, field: string): void {
  ensure(
    RFC3339_RE.test(value) && !Number.isNaN(Date.parse(value)),
    () =>
      new DataError(`${field} is not an RFC 3339 timestamp: "${value}"`, {
        hint: `pass an instant like 2026-07-31T12:00:00Z, or omit ${field}.`,
      })
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/db/time.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/db/time.mts plugins/dispatch/src/lib/db/time.test.mts
git commit -m "feat: add ISO-8601 timestamp helpers"
```

---

### Task 3: Database connection and schema

**Files:**
- Create: `plugins/dispatch/src/lib/db/schema.mts`
- Create: `plugins/dispatch/src/lib/db/database.mts`
- Test: `plugins/dispatch/src/lib/db/database.test.mts`

**Interfaces:**
- Consumes: `DispatchError`, `EnvironmentError` from `../errors/index.mts`.
- Produces:
  - `SCHEMA: string`, `SCHEMA_VERSION: number` (from `schema.mts`).
  - `type SqlValue = string | number | null`, `type Row = Record<string, unknown>`.
  - `class Database` with `static open(path: string): Promise<Database>`, `close(): Promise<void>`, `transaction<T>(body: () => T): Promise<T>`, `run(sql, params?): number`, `get(sql, params?): Row | undefined`, `all(sql, params?): Row[]`, `guard<T>(body: () => T): T`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {EnvironmentError} from '../errors/index.mts';
import {Database} from './database.mts';

describe('Database', () => {
  it('bootstraps the schema so satellites can be written', async () => {
    const db = await Database.open(':memory:');
    db.run("INSERT INTO node (external_id, kind) VALUES ('P1', 'project')");
    db.run('INSERT INTO project (node_id, name) VALUES (?, ?)', [
      Number(db.get("SELECT id FROM node WHERE external_id = 'P1'")?.id),
      'Platform',
    ]);
    assert.equal(db.get('SELECT name FROM project')?.name, 'Platform');
    await db.close();
  });

  it('enforces foreign keys so a bad reference is rejected', async () => {
    const db = await Database.open(':memory:');
    assert.throws(() => {
      db.run('INSERT INTO project (node_id, name) VALUES (999, ?)', ['X']);
    });
    await db.close();
  });

  it('cascades a session delete to its claims', async () => {
    const db = await Database.open(':memory:');
    db.run("INSERT INTO node (external_id, kind) VALUES ('T1', 'ticket')");
    const nid = Number(db.get("SELECT id FROM node WHERE external_id = 'T1'")?.id);
    db.run(
      "INSERT INTO session (id, started_at, heartbeat_at) VALUES ('s1', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')"
    );
    db.run(
      "INSERT INTO claim (node_id, session_id, claimed_at) VALUES (?, 's1', '2026-07-31T00:00:00Z')",
      [nid]
    );
    db.run("DELETE FROM session WHERE id = 's1'");
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM claim')?.n), 0);
    await db.close();
  });

  it('refuses a database written by another schema version', async () => {
    const db = await Database.open(':memory:');
    // Simulate a foreign version, then reopen the same connection's file is not
    // possible for :memory:, so assert the guard path directly:
    db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    assert.throws(
      () => Database.assertVersion(db, ':memory:'),
      (err: unknown) => err instanceof EnvironmentError
    );
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/db/database.test.mts`
Expected: FAIL — cannot find `./database.mts`.

- [ ] **Step 3: Write minimal implementation**

`schema.mts`:

```ts
/**
 * Bumped on any change an existing database file cannot absorb. `Database.open`
 * refuses a file whose recorded version differs. The database is a rebuildable
 * cache (the graph re-derives from a full sync; sessions/claims/slots are pure
 * runtime state), so a bump's recovery is "delete the file and re-sync" — there
 * is no migration machinery.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS node (
  id          INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('project','milestone','ticket','pr','unknown'))
) STRICT;

CREATE TABLE IF NOT EXISTS project (
  node_id INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  name    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS milestone (
  node_id    INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES node(id),
  name       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS ticket (
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
  labels         TEXT NOT NULL,
  updated_at     TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS pr (
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

CREATE TABLE IF NOT EXISTS edge (
  blocker INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  blocked INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker, blocked),
  CHECK (blocker <> blocked)
) STRICT;

CREATE TABLE IF NOT EXISTS session (
  id           TEXT PRIMARY KEY,
  host         TEXT,
  pid          INTEGER,
  started_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS claim (
  node_id    INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  actor      TEXT,
  worktree   TEXT,
  branch     TEXT,
  claimed_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS slot (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  UNIQUE (session_id, actor)
) STRICT;

CREATE TABLE IF NOT EXISTS outcome (
  node_id     INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  outcome     TEXT NOT NULL CHECK (outcome IN
                ('verified','canceled','delivered','human-blocked','decomposed','failed')),
  retryable   INTEGER CHECK (retryable IN (0,1)),
  detail      TEXT,
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS review (
  milestone_id INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  recorded_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS review_member (
  milestone_id       INTEGER NOT NULL REFERENCES review(milestone_id) ON DELETE CASCADE,
  member_external_id TEXT NOT NULL,
  PRIMARY KEY (milestone_id, member_external_id)
) STRICT;

CREATE TABLE IF NOT EXISTS cursor (
  source TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ticket_project    ON ticket (project_id);
CREATE INDEX IF NOT EXISTS milestone_project ON milestone (project_id);
CREATE INDEX IF NOT EXISTS pr_ticket         ON pr (ticket_id);
CREATE INDEX IF NOT EXISTS edge_blocked      ON edge (blocked);
CREATE INDEX IF NOT EXISTS claim_session     ON claim (session_id);
`;
```

`database.mts` (port of the old `Database`, on the src error taxonomy):

```ts
import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {DispatchError, EnvironmentError} from '../errors/index.mts';
import {SCHEMA, SCHEMA_VERSION} from './schema.mts';

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

/* eslint-disable @typescript-eslint/require-await --
 * The async signatures are the point of this class. `node:sqlite` is synchronous
 * today; these methods are async so an async driver later is a change behind this
 * facade, not a rewrite of every call site. */

/**
 * The dispatch database: one SQLite file holding everything the CLI persists.
 * Owns the connection — pragmas, schema bootstrap, version enforcement,
 * transactions — and nothing about what the tables mean; the stores sit on top.
 */
export class Database {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static async open(path: string): Promise<Database> {
    if (path !== ':memory:') {
      try {
        await mkdir(dirname(path), {recursive: true});
      } catch (cause) {
        throw new EnvironmentError(
          'cannot create the directory for the dispatch database',
          {cause, hint: 'check the path is writable, or point --db elsewhere.'}
        );
      }
    }
    try {
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA busy_timeout = 5000');
      raw.exec('PRAGMA foreign_keys = ON');
      const db = new Database(raw);
      db.#bootstrap(path);
      return db;
    } catch (cause) {
      if (cause instanceof DispatchError) throw cause;
      throw new EnvironmentError('cannot open the dispatch database', {
        cause,
        hint: 'check the file is a readable, writable SQLite database and the disk is not full. If it is locked, another dispatch command is mid-write — retry shortly. Deleting the file forces a rebuild.',
      });
    }
  }

  #bootstrap(path: string): void {
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT'
    );
    const row = this.#db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as Row | undefined;
    Database.assertVersion(this, path, row?.value as string | undefined);
    this.#db.exec(SCHEMA);
    if (row === undefined) {
      this.#db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(SCHEMA_VERSION));
    }
  }

  /**
   * Refuse a file another schema version wrote. Exposed static so a test can
   * exercise the guard without a second connection. `found` defaults to the
   * value recorded in `meta`.
   */
  static assertVersion(db: Database, path: string, found?: string): void {
    const recorded =
      found ??
      (db.get("SELECT value FROM meta WHERE key = 'schema_version'")?.value as
        | string
        | undefined);
    if (recorded !== undefined && recorded !== String(SCHEMA_VERSION)) {
      throw new EnvironmentError(
        'the dispatch database was written by another schema version',
        {
          hint: 'delete the file and re-run a full sync. Claims and recorded reviews go with it — release or re-record what still matters first.',
        }
      );
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  async transaction<T>(body: () => T): Promise<T> {
    return this.guard(() => {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const result = body();
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.#db.exec('ROLLBACK');
        } catch {
          // A failing ROLLBACK must not replace the error that caused it.
        }
        throw error;
      }
    });
  }

  guard<T>(body: () => T): T {
    try {
      return body();
    } catch (cause) {
      if (cause instanceof DispatchError) throw cause;
      throw new EnvironmentError('the dispatch database rejected an operation', {
        cause,
        hint: 'if the database is locked, another dispatch command is mid-write — retry shortly. Otherwise check the file is a writable SQLite database and the disk is not full.',
      });
    }
  }

  run(sql: string, params: SqlValue[] = []): number {
    return this.guard(() => Number(this.#db.prepare(sql).run(...params).changes));
  }

  get(sql: string, params: SqlValue[] = []): Row | undefined {
    return this.guard(() => this.#db.prepare(sql).get(...params) as Row | undefined);
  }

  all(sql: string, params: SqlValue[] = []): Row[] {
    return this.guard(() => this.#db.prepare(sql).all(...params) as Row[]);
  }
}

/* eslint-enable @typescript-eslint/require-await */
```

Note the test's version case calls `Database.assertVersion(db, ':memory:')` after mutating `meta`; the static reads the recorded value itself when `found` is omitted.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/db/database.test.mts`
Expected: PASS (all four cases)

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/db/schema.mts plugins/dispatch/src/lib/db/database.mts plugins/dispatch/src/lib/db/database.test.mts
git commit -m "feat: add the dispatch database connection and schema"
```

---

### Task 4: Domain models and vocabulary

**Files:**
- Create: `plugins/dispatch/src/lib/model/status.mts`
- Create: `plugins/dispatch/src/lib/model/types.mts`
- Test: `plugins/dispatch/src/lib/model/status.test.mts`

**Interfaces:**
- Produces (from `status.mts`): `KINDS`, `type Kind`, `type ConcreteKind`; `STATUSES`, `type Status`, `type StatusGroup`, `GROUP_OF`, `RESOLVED_STATUSES`, `isStatus`, `isResolved`, `STATUS_LIST`; `TARGET_KINDS`, `type TargetKind`, `isTargetKind`, `TARGET_KIND_LIST`; `PR_ORIGINS`, `type PrOrigin`, `isPrOrigin`, `PR_ORIGIN_LIST`; `OUTCOMES`, `type OutcomeKind`, `isOutcome`.
- Produces (from `types.mts`): `Project`, `Milestone`, `Ticket`, `Pr`, `Edge`, `Session`, `Claim`, `Slot`, `Outcome` interfaces used across every store.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  GROUP_OF,
  isResolved,
  isStatus,
  isTargetKind,
  isPrOrigin,
  STATUSES,
} from './status.mts';

describe('status vocabulary', () => {
  it('classifies every status into a group', () => {
    for (const status of STATUSES) {
      assert.ok(GROUP_OF[status], `${status} has a group`);
    }
  });

  it('treats verified and canceled as resolved, others not', () => {
    assert.equal(isResolved('verified'), true);
    assert.equal(isResolved('canceled'), true);
    assert.equal(isResolved('in-progress'), false);
  });

  it('guards reject unknown values', () => {
    assert.equal(isStatus('available'), true);
    assert.equal(isStatus('nope'), false);
    assert.equal(isTargetKind('pr'), true);
    assert.equal(isTargetKind('bare-pr'), false);
    assert.equal(isPrOrigin('resumed'), true);
    assert.equal(isPrOrigin('reopened'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/model/status.test.mts`
Expected: FAIL — cannot find `./status.mts`.

- [ ] **Step 3: Write minimal implementation**

`status.mts`:

```ts
export const KINDS = ['project', 'milestone', 'ticket', 'pr', 'unknown'] as const;
export type Kind = (typeof KINDS)[number];
export type ConcreteKind = Exclude<Kind, 'unknown'>;

export const STATUSES = [
  'backlog',
  'paused',
  'awaiting-external',
  'available',
  'in-progress',
  'in-review',
  'finished',
  'delivered',
  'verified',
  'canceled',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_GROUPS = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];

export const GROUP_OF: Readonly<Record<Status, StatusGroup>> = Object.freeze({
  backlog: 'backlog',
  paused: 'backlog',
  'awaiting-external': 'backlog',
  available: 'unstarted',
  'in-progress': 'started',
  'in-review': 'started',
  finished: 'started',
  delivered: 'started',
  verified: 'completed',
  canceled: 'canceled',
});

/** Statuses that stop a ticket blocking its dependents (effective blocking). */
export const RESOLVED_STATUSES: ReadonlySet<Status> = new Set<Status>([
  'verified',
  'canceled',
]);

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function isResolved(status: Status): boolean {
  return RESOLVED_STATUSES.has(status);
}

export const TARGET_KINDS = ['pr', 'verification', 'human-only'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export function isTargetKind(value: string): value is TargetKind {
  return (TARGET_KINDS as readonly string[]).includes(value);
}

export const PR_ORIGINS = ['prompt', 'ticket', 'adopted', 'resumed'] as const;
export type PrOrigin = (typeof PR_ORIGINS)[number];

export function isPrOrigin(value: string): value is PrOrigin {
  return (PR_ORIGINS as readonly string[]).includes(value);
}

export const OUTCOMES = [
  'verified',
  'canceled',
  'delivered',
  'human-blocked',
  'decomposed',
  'failed',
] as const;
export type OutcomeKind = (typeof OUTCOMES)[number];

export function isOutcome(value: string): value is OutcomeKind {
  return (OUTCOMES as readonly string[]).includes(value);
}

export const STATUS_LIST = STATUSES.join(', ');
export const TARGET_KIND_LIST = TARGET_KINDS.join(', ');
export const PR_ORIGIN_LIST = PR_ORIGINS.join(', ');
```

`types.mts`:

```ts
import type {OutcomeKind, PrOrigin, Status, TargetKind} from './status.mts';

/** Every entity's `id` is its tracker/forge external id (e.g. `CLC-945`). */
export interface Project {
  id: string;
  name: string;
}

export interface Milestone {
  id: string;
  project: string;
  name: string;
}

export interface Ticket {
  id: string;
  project: string;
  url: string;
  title: string;
  status: Status;
  targetKind: TargetKind;
  requiresHuman: boolean;
  /** Injected at run time; ranks to the top of the frontier. */
  injected: boolean;
  /** Lower is more urgent; `null` sorts last. */
  priority: number | null;
  branchHint: string | null;
  labels: string[];
  updatedAt: string | null;
}

export interface Pr {
  id: string;
  /** The originating ticket, or null for a bare PR / raw prompt. */
  ticket: string | null;
  origin: PrOrigin;
  repo: string | null;
  prNumber: number | null;
  url: string | null;
  branch: string | null;
  title: string;
  injected: boolean;
  priority: number | null;
  updatedAt: string | null;
}

/** `blocker` blocks `blocked` — i.e. `blocked` depends on `blocker`. */
export interface Edge {
  blocker: string;
  blocked: string;
}

export interface Session {
  id: string;
  host: string | null;
  pid: number | null;
  startedAt: string;
  heartbeatAt: string;
}

export interface Claim {
  node: string;
  session: string;
  actor: string | null;
  worktree: string | null;
  branch: string | null;
  claimedAt: string;
}

export interface Slot {
  id: number;
  session: string;
  actor: string;
  acquiredAt: string;
}

export interface Outcome {
  node: string;
  outcome: OutcomeKind;
  /** Meaningful only for `failed`; null otherwise. */
  retryable: boolean | null;
  detail: string | null;
  recordedAt: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/model/status.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/model/
git commit -m "feat: add domain models and status vocabulary"
```

---

### Task 5: Node materialization helper

**Files:**
- Create: `plugins/dispatch/src/lib/stores/materialize.mts`
- Test: `plugins/dispatch/src/lib/stores/materialize.test.mts`

**Interfaces:**
- Consumes: `Database` (`../db/database.mts`), `DataError`/`ensure` (`../errors/index.mts`), `type Kind`/`type ConcreteKind` (`../model/status.mts`).
- Produces:
  - `interface NodeRow { id: number; kind: Kind }`
  - `findNode(db: Database, externalId: string): NodeRow | null`
  - `nodeRef(db: Database, externalId: string): number` — get-or-create an `unknown` placeholder.
  - `materialize(db: Database, externalId: string, kind: ConcreteKind): number` — create with kind, or promote a placeholder; an id already holding a *different* concrete kind is a `DataError`.

  All are plain functions (not a class): they run inside a store's transaction on the passed `db`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import {findNode, materialize, nodeRef} from './materialize.mts';

describe('materialize', () => {
  it('creates a node with its kind', async () => {
    const db = await Database.open(':memory:');
    const id = materialize(db, 'CLC-1', 'ticket');
    assert.equal(findNode(db, 'CLC-1')?.kind, 'ticket');
    assert.equal(findNode(db, 'CLC-1')?.id, id);
    await db.close();
  });

  it('promotes a placeholder created by nodeRef', async () => {
    const db = await Database.open(':memory:');
    const placeholder = nodeRef(db, 'CLC-1');
    assert.equal(findNode(db, 'CLC-1')?.kind, 'unknown');
    const promoted = materialize(db, 'CLC-1', 'ticket');
    assert.equal(promoted, placeholder, 'promotion keeps the same node id');
    assert.equal(findNode(db, 'CLC-1')?.kind, 'ticket');
    await db.close();
  });

  it('rejects reusing an id as a second concrete kind', async () => {
    const db = await Database.open(':memory:');
    materialize(db, 'CLC-1', 'ticket');
    assert.throws(
      () => materialize(db, 'CLC-1', 'milestone'),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/materialize.test.mts`
Expected: FAIL — cannot find `./materialize.mts`.

- [ ] **Step 3: Write minimal implementation**

`materialize.mts`:

```ts
import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import type {ConcreteKind, Kind} from '../model/status.mts';

export interface NodeRow {
  id: number;
  kind: Kind;
}

export function findNode(db: Database, externalId: string): NodeRow | null {
  const row = db.get('SELECT id, kind FROM node WHERE external_id = ?', [
    externalId,
  ]);
  if (row === undefined) return null;
  return {id: Number(row.id), kind: row.kind as Kind};
}

/** The node for an id, creating an `unknown` placeholder when nobody wrote it. */
export function nodeRef(db: Database, externalId: string): number {
  const existing = findNode(db, externalId);
  if (existing !== null) return existing.id;
  db.run("INSERT INTO node (external_id, kind) VALUES (?, 'unknown')", [
    externalId,
  ]);
  const created = findNode(db, externalId);
  ensure(created !== null, () => new DataError('a node just inserted must exist'));
  return created.id;
}

/**
 * The node for a satellite being written: created with its kind, or promoted
 * from a placeholder. Any kind may block any other, so promotion has no edge
 * legality to check — only that the id is not already the *other* concrete kind.
 */
export function materialize(
  db: Database,
  externalId: string,
  kind: ConcreteKind
): number {
  const existing = findNode(db, externalId);
  if (existing === null) {
    db.run('INSERT INTO node (external_id, kind) VALUES (?, ?)', [
      externalId,
      kind,
    ]);
    const created = findNode(db, externalId);
    ensure(
      created !== null,
      () => new DataError('a node just inserted must exist')
    );
    return created.id;
  }
  if (existing.kind === kind) return existing.id;
  ensure(
    existing.kind === 'unknown',
    () =>
      new DataError(
        `id "${externalId}" is already a ${existing.kind}; it cannot also be a ${kind}`,
        {
          hint: `entities share one id space — give the ${kind} a different id, or remove the ${existing.kind} first.`,
        }
      )
  );
  db.run('UPDATE node SET kind = ? WHERE id = ?', [kind, existing.id]);
  return existing.id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/stores/materialize.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/stores/materialize.mts plugins/dispatch/src/lib/stores/materialize.test.mts
git commit -m "feat: add node materialization helper"
```

---

### Task 6: ProjectStore

**Files:**
- Create: `plugins/dispatch/src/lib/stores/project.mts`
- Test: `plugins/dispatch/src/lib/stores/project.test.mts`

**Interfaces:**
- Consumes: `Database`, `materialize`/`findNode` (`./materialize.mts`), `type Project` (`../model/types.mts`).
- Produces: `class ProjectStore` with `upsertProject(p: {id: string; name: string}): Promise<void>`, `removeProject(id: string): Promise<boolean>`, `getProject(id: string): Promise<Project | null>`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {ProjectStore} from './project.mts';

async function fresh(): Promise<{db: Database; store: ProjectStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new ProjectStore(db)};
}

describe('ProjectStore', () => {
  it('upserts and reads a project', async () => {
    const {db, store} = await fresh();
    await store.upsertProject({id: 'P1', name: 'Platform'});
    assert.deepEqual(await store.getProject('P1'), {id: 'P1', name: 'Platform'});
    await store.upsertProject({id: 'P1', name: 'Platform Renamed'});
    assert.equal((await store.getProject('P1'))?.name, 'Platform Renamed');
    await db.close();
  });

  it('demotes to a placeholder when a ticket still references it', async () => {
    const {db, store} = await fresh();
    await store.upsertProject({id: 'P1', name: 'Platform'});
    const pid = Number(db.get("SELECT id FROM node WHERE external_id='P1'")?.id);
    db.run("INSERT INTO node (external_id, kind) VALUES ('CLC-1','ticket')");
    const tid = Number(db.get("SELECT id FROM node WHERE external_id='CLC-1'")?.id);
    db.run(
      "INSERT INTO ticket (node_id, project_id, url, title, status, target_kind, requires_human, injected, labels) VALUES (?,?, '', 't', 'available', 'pr', 0, 0, '[]')",
      [tid, pid]
    );
    assert.equal(await store.removeProject('P1'), true);
    assert.equal(await store.getProject('P1'), null);
    assert.equal(db.get("SELECT kind FROM node WHERE external_id='P1'")?.kind, 'unknown');
    await db.close();
  });

  it('deletes the node when nothing references it', async () => {
    const {db, store} = await fresh();
    await store.upsertProject({id: 'P1', name: 'Platform'});
    assert.equal(await store.removeProject('P1'), true);
    assert.equal(db.get("SELECT 1 FROM node WHERE external_id='P1'"), undefined);
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/project.test.mts`
Expected: FAIL — cannot find `./project.mts`.

- [ ] **Step 3: Write minimal implementation**

`project.mts`:

```ts
import type {Database} from '../db/database.mts';
import type {Project} from '../model/types.mts';
import {findNode, materialize} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/** Projects: the 1:1 scoping partition tickets and milestones belong to. */
export class ProjectStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async upsertProject(project: {id: string; name: string}): Promise<void> {
    await this.#db.transaction(() => {
      const nodeId = materialize(this.#db, project.id, 'project');
      this.#db.run(
        `INSERT INTO project (node_id, name) VALUES (?, ?)
         ON CONFLICT(node_id) DO UPDATE SET name = excluded.name`,
        [nodeId, project.name]
      );
    });
  }

  /**
   * Remove a project. If a ticket or milestone still names it, demote its node
   * to an `unknown` placeholder (the reference stays valid); otherwise delete
   * the node outright. Returns whether a declared project was found.
   */
  async removeProject(id: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const node = findNode(this.#db, id);
      if (node?.kind !== 'project') return false;
      const referenced =
        this.#db.get(
          `SELECT 1 FROM ticket WHERE project_id = ?
           UNION SELECT 1 FROM milestone WHERE project_id = ? LIMIT 1`,
          [node.id, node.id]
        ) !== undefined;
      this.#db.run('DELETE FROM project WHERE node_id = ?', [node.id]);
      if (referenced) {
        this.#db.run("UPDATE node SET kind = 'unknown' WHERE id = ?", [node.id]);
      } else {
        this.#db.run('DELETE FROM node WHERE id = ?', [node.id]);
      }
      return true;
    });
  }

  async getProject(id: string): Promise<Project | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS id, p.name AS name
       FROM project p JOIN node n ON n.id = p.node_id
       WHERE n.external_id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {id: String(row.id), name: String(row.name)};
  }
}

/* eslint-enable @typescript-eslint/require-await */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/stores/project.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/stores/project.mts plugins/dispatch/src/lib/stores/project.test.mts
git commit -m "feat: add ProjectStore"
```

---

### Task 7: MilestoneStore

**Files:**
- Create: `plugins/dispatch/src/lib/stores/milestone.mts`
- Test: `plugins/dispatch/src/lib/stores/milestone.test.mts`

**Interfaces:**
- Consumes: `Database`, `materialize`/`nodeRef`/`findNode` (`./materialize.mts`), `type Milestone` (`../model/types.mts`).
- Produces: `class MilestoneStore` with `upsertMilestone(m: Milestone): Promise<void>`, `removeMilestone(id: string): Promise<boolean>`, `getMilestone(id: string): Promise<Milestone | null>`. (`recordReview` is Plan 2.)
- Note: `project` is referenced via `nodeRef` (a placeholder is fine — the project may not be synced yet).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {MilestoneStore} from './milestone.mts';

async function fresh(): Promise<{db: Database; store: MilestoneStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new MilestoneStore(db)};
}

describe('MilestoneStore', () => {
  it('upserts and reads a milestone, placeholdering its project', async () => {
    const {db, store} = await fresh();
    await store.upsertMilestone({id: 'M1', project: 'P1', name: 'Alpha'});
    assert.deepEqual(await store.getMilestone('M1'), {
      id: 'M1',
      project: 'P1',
      name: 'Alpha',
    });
    assert.equal(db.get("SELECT kind FROM node WHERE external_id='P1'")?.kind, 'unknown');
    await db.close();
  });

  it('removing a milestone cascades its membership edges', async () => {
    const {db, store} = await fresh();
    await store.upsertMilestone({id: 'M1', project: 'P1', name: 'Alpha'});
    const mid = Number(db.get("SELECT id FROM node WHERE external_id='M1'")?.id);
    db.run("INSERT INTO node (external_id, kind) VALUES ('CLC-1','ticket')");
    const tid = Number(db.get("SELECT id FROM node WHERE external_id='CLC-1'")?.id);
    db.run('INSERT INTO edge (blocker, blocked) VALUES (?, ?)', [tid, mid]);
    assert.equal(await store.removeMilestone('M1'), true);
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM edge')?.n), 0);
    assert.equal(await store.getMilestone('M1'), null);
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/milestone.test.mts`
Expected: FAIL — cannot find `./milestone.mts`.

- [ ] **Step 3: Write minimal implementation**

`milestone.mts`:

```ts
import type {Database} from '../db/database.mts';
import type {Milestone} from '../model/types.mts';
import {findNode, materialize, nodeRef} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/**
 * Milestones. Membership is not stored here — a ticket belongs to a milestone by
 * blocking it (a `ticket → milestone` edge), so removing a milestone node lets
 * the edge FK cascade its membership away.
 */
export class MilestoneStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async upsertMilestone(milestone: Milestone): Promise<void> {
    await this.#db.transaction(() => {
      const projectId = nodeRef(this.#db, milestone.project);
      const nodeId = materialize(this.#db, milestone.id, 'milestone');
      this.#db.run(
        `INSERT INTO milestone (node_id, project_id, name) VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           project_id = excluded.project_id, name = excluded.name`,
        [nodeId, projectId, milestone.name]
      );
    });
  }

  /** Remove a milestone; its edges, claim, and review cascade via node FKs. */
  async removeMilestone(id: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const node = findNode(this.#db, id);
      if (node?.kind !== 'milestone') return false;
      this.#db.run('DELETE FROM node WHERE id = ?', [node.id]);
      return true;
    });
  }

  async getMilestone(id: string): Promise<Milestone | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS id, pn.external_id AS project, m.name AS name
       FROM milestone m
       JOIN node n ON n.id = m.node_id
       JOIN node pn ON pn.id = m.project_id
       WHERE n.external_id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {
      id: String(row.id),
      project: String(row.project),
      name: String(row.name),
    };
  }
}

/* eslint-enable @typescript-eslint/require-await */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/stores/milestone.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/stores/milestone.mts plugins/dispatch/src/lib/stores/milestone.test.mts
git commit -m "feat: add MilestoneStore"
```

---

### Task 8: TicketStore

**Files:**
- Create: `plugins/dispatch/src/lib/stores/ticket.mts`
- Test: `plugins/dispatch/src/lib/stores/ticket.test.mts`

**Interfaces:**
- Consumes: `Database`, `materialize`/`nodeRef`/`findNode` (`./materialize.mts`), `type Ticket` (`../model/types.mts`), `isStatus`/`isTargetKind`/`STATUS_LIST`/`TARGET_KIND_LIST` (`../model/status.mts`), `assertInstant` (`../db/time.mts`), `DataError`/`ensure` (`../errors/index.mts`).
- Produces: `class TicketStore` with `upsertTicket(t: Ticket): Promise<void>`, `removeTicket(id: string): Promise<boolean>`, `getTicket(id: string): Promise<Ticket | null>`.
- Validates `status`, `target_kind`, and `updatedAt` in code (a `DataError`) before the write, so a SQLite CHECK failure never surfaces as an `EnvironmentError`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import type {Ticket} from '../model/types.mts';
import {TicketStore} from './ticket.mts';

const BASE: Ticket = {
  id: 'CLC-1',
  project: 'P1',
  url: 'https://x/CLC-1',
  title: 'Do the thing',
  status: 'available',
  targetKind: 'pr',
  requiresHuman: false,
  injected: false,
  priority: 2.5,
  branchHint: 'clc-1',
  labels: ['backend', 'urgent'],
  updatedAt: '2026-07-31T12:00:00.000Z',
};

async function fresh(): Promise<{db: Database; store: TicketStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new TicketStore(db)};
}

describe('TicketStore', () => {
  it('round-trips a ticket including labels and booleans', async () => {
    const {db, store} = await fresh();
    await store.upsertTicket(BASE);
    assert.deepEqual(await store.getTicket('CLC-1'), BASE);
    await db.close();
  });

  it('rejects an unknown status with a DataError', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.upsertTicket({...BASE, status: 'nope' as Ticket['status']}),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });

  it('removing a ticket cascades its edges and claim', async () => {
    const {db, store} = await fresh();
    await store.upsertTicket(BASE);
    const tid = Number(db.get("SELECT id FROM node WHERE external_id='CLC-1'")?.id);
    db.run("INSERT INTO node (external_id, kind) VALUES ('M1','milestone')");
    const mid = Number(db.get("SELECT id FROM node WHERE external_id='M1'")?.id);
    db.run('INSERT INTO edge (blocker, blocked) VALUES (?, ?)', [tid, mid]);
    assert.equal(await store.removeTicket('CLC-1'), true);
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM edge')?.n), 0);
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/ticket.test.mts`
Expected: FAIL — cannot find `./ticket.mts`.

- [ ] **Step 3: Write minimal implementation**

`ticket.mts`:

```ts
import {assertInstant} from '../db/time.mts';
import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import {
  isStatus,
  isTargetKind,
  STATUS_LIST,
  TARGET_KIND_LIST,
} from '../model/status.mts';
import type {Ticket} from '../model/types.mts';
import {findNode, materialize, nodeRef} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export class TicketStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async upsertTicket(ticket: Ticket): Promise<void> {
    ensure(
      isStatus(ticket.status),
      () =>
        new DataError(`"${ticket.status}" is not a status`, {
          hint: `use one of: ${STATUS_LIST}.`,
        })
    );
    ensure(
      isTargetKind(ticket.targetKind),
      () =>
        new DataError(`"${ticket.targetKind}" is not a target kind`, {
          hint: `use one of: ${TARGET_KIND_LIST}.`,
        })
    );
    if (ticket.updatedAt !== null) assertInstant(ticket.updatedAt, '--updated-at');

    await this.#db.transaction(() => {
      const projectId = nodeRef(this.#db, ticket.project);
      const nodeId = materialize(this.#db, ticket.id, 'ticket');
      this.#db.run(
        `INSERT INTO ticket (
           node_id, project_id, url, title, status, target_kind,
           requires_human, injected, priority, branch_hint, labels, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           project_id = excluded.project_id, url = excluded.url,
           title = excluded.title, status = excluded.status,
           target_kind = excluded.target_kind,
           requires_human = excluded.requires_human,
           injected = excluded.injected, priority = excluded.priority,
           branch_hint = excluded.branch_hint, labels = excluded.labels,
           updated_at = excluded.updated_at`,
        [
          nodeId,
          projectId,
          ticket.url,
          ticket.title,
          ticket.status,
          ticket.targetKind,
          ticket.requiresHuman ? 1 : 0,
          ticket.injected ? 1 : 0,
          ticket.priority,
          ticket.branchHint,
          JSON.stringify(ticket.labels),
          ticket.updatedAt,
        ]
      );
    });
  }

  /** Remove a ticket; its satellite, edges, claim, and outcome cascade. */
  async removeTicket(id: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const node = findNode(this.#db, id);
      if (node?.kind !== 'ticket') return false;
      this.#db.run('DELETE FROM node WHERE id = ?', [node.id]);
      return true;
    });
  }

  async getTicket(id: string): Promise<Ticket | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS id, pn.external_id AS project, t.url, t.title,
              t.status, t.target_kind, t.requires_human, t.injected, t.priority,
              t.branch_hint, t.labels, t.updated_at
       FROM ticket t
       JOIN node n ON n.id = t.node_id
       JOIN node pn ON pn.id = t.project_id
       WHERE n.external_id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {
      id: String(row.id),
      project: String(row.project),
      url: String(row.url),
      title: String(row.title),
      status: row.status as Ticket['status'],
      targetKind: row.target_kind as Ticket['targetKind'],
      requiresHuman: row.requires_human === 1,
      injected: row.injected === 1,
      priority: row.priority === null ? null : Number(row.priority),
      branchHint: row.branch_hint === null ? null : String(row.branch_hint),
      labels: JSON.parse(String(row.labels)) as string[],
      updatedAt: row.updated_at === null ? null : String(row.updated_at),
    };
  }
}

/* eslint-enable @typescript-eslint/require-await */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/stores/ticket.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/stores/ticket.mts plugins/dispatch/src/lib/stores/ticket.test.mts
git commit -m "feat: add TicketStore"
```

---

### Task 9: PrStore

**Files:**
- Create: `plugins/dispatch/src/lib/stores/pr.mts`
- Test: `plugins/dispatch/src/lib/stores/pr.test.mts`

**Interfaces:**
- Consumes: `Database`, `materialize`/`nodeRef`/`findNode` (`./materialize.mts`), `type Pr` (`../model/types.mts`), `isPrOrigin`/`PR_ORIGIN_LIST` (`../model/status.mts`), `assertInstant` (`../db/time.mts`), `DataError`/`ensure` (`../errors/index.mts`).
- Produces: `class PrStore` with `upsertPr(p: Pr): Promise<void>`, `removePr(id: string): Promise<boolean>`, `getPr(id: string): Promise<Pr | null>`.
- `ticket` is referenced via `nodeRef` when present (a placeholder is fine); a `null` ticket leaves `ticket_id` null.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import type {Pr} from '../model/types.mts';
import {PrStore} from './pr.mts';

const BARE: Pr = {
  id: 'acme/api#412',
  ticket: null,
  origin: 'adopted',
  repo: 'acme/api',
  prNumber: 412,
  url: 'https://github.com/acme/api/pull/412',
  branch: 'fix-thing',
  title: 'Fix the thing',
  injected: true,
  priority: null,
  updatedAt: null,
};

async function fresh(): Promise<{db: Database; store: PrStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new PrStore(db)};
}

describe('PrStore', () => {
  it('round-trips a bare PR with no ticket', async () => {
    const {db, store} = await fresh();
    await store.upsertPr(BARE);
    assert.deepEqual(await store.getPr('acme/api#412'), BARE);
    await db.close();
  });

  it('links a ticket-derived PR via a placeholder', async () => {
    const {db, store} = await fresh();
    await store.upsertPr({...BARE, ticket: 'CLC-1', origin: 'ticket'});
    assert.equal((await store.getPr('acme/api#412'))?.ticket, 'CLC-1');
    assert.equal(db.get("SELECT kind FROM node WHERE external_id='CLC-1'")?.kind, 'unknown');
    await db.close();
  });

  it('rejects an unknown origin with a DataError', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.upsertPr({...BARE, origin: 'reopened' as Pr['origin']}),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/pr.test.mts`
Expected: FAIL — cannot find `./pr.mts`.

- [ ] **Step 3: Write minimal implementation**

`pr.mts`:

```ts
import {assertInstant} from '../db/time.mts';
import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import {isPrOrigin, PR_ORIGIN_LIST} from '../model/status.mts';
import type {Pr} from '../model/types.mts';
import {findNode, materialize, nodeRef} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export class PrStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async upsertPr(pr: Pr): Promise<void> {
    ensure(
      isPrOrigin(pr.origin),
      () =>
        new DataError(`"${pr.origin}" is not a pr origin`, {
          hint: `use one of: ${PR_ORIGIN_LIST}.`,
        })
    );
    if (pr.updatedAt !== null) assertInstant(pr.updatedAt, '--updated-at');

    await this.#db.transaction(() => {
      const nodeId = materialize(this.#db, pr.id, 'pr');
      const ticketId = pr.ticket === null ? null : nodeRef(this.#db, pr.ticket);
      this.#db.run(
        `INSERT INTO pr (
           node_id, ticket_id, origin, repo, pr_number, url, branch, title,
           injected, priority, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           ticket_id = excluded.ticket_id, origin = excluded.origin,
           repo = excluded.repo, pr_number = excluded.pr_number,
           url = excluded.url, branch = excluded.branch, title = excluded.title,
           injected = excluded.injected, priority = excluded.priority,
           updated_at = excluded.updated_at`,
        [
          nodeId,
          ticketId,
          pr.origin,
          pr.repo,
          pr.prNumber,
          pr.url,
          pr.branch,
          pr.title,
          pr.injected ? 1 : 0,
          pr.priority,
          pr.updatedAt,
        ]
      );
    });
  }

  async removePr(id: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const node = findNode(this.#db, id);
      if (node?.kind !== 'pr') return false;
      this.#db.run('DELETE FROM node WHERE id = ?', [node.id]);
      return true;
    });
  }

  async getPr(id: string): Promise<Pr | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS id, tn.external_id AS ticket, p.origin, p.repo,
              p.pr_number, p.url, p.branch, p.title, p.injected, p.priority,
              p.updated_at
       FROM pr p
       JOIN node n ON n.id = p.node_id
       LEFT JOIN node tn ON tn.id = p.ticket_id
       WHERE n.external_id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {
      id: String(row.id),
      ticket: row.ticket === null ? null : String(row.ticket),
      origin: row.origin as Pr['origin'],
      repo: row.repo === null ? null : String(row.repo),
      prNumber: row.pr_number === null ? null : Number(row.pr_number),
      url: row.url === null ? null : String(row.url),
      branch: row.branch === null ? null : String(row.branch),
      title: String(row.title),
      injected: row.injected === 1,
      priority: row.priority === null ? null : Number(row.priority),
      updatedAt: row.updated_at === null ? null : String(row.updated_at),
    };
  }
}

/* eslint-enable @typescript-eslint/require-await */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/stores/pr.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/stores/pr.mts plugins/dispatch/src/lib/stores/pr.test.mts
git commit -m "feat: add PrStore"
```

---

### Task 10: EdgeStore

**Files:**
- Create: `plugins/dispatch/src/lib/stores/edge.mts`
- Test: `plugins/dispatch/src/lib/stores/edge.test.mts`

**Interfaces:**
- Consumes: `Database`, `nodeRef` (`./materialize.mts`), `type Edge` (`../model/types.mts`), `DataError`/`ensure` (`../errors/index.mts`).
- Produces: `class EdgeStore` with `addEdge(blocker: string, blocked: string): Promise<boolean>`, `removeEdge(blocker: string, blocked: string): Promise<boolean>`, `setEdges(node: string, direction: 'blockers' | 'blocks', others: readonly string[]): Promise<void>`, `edges(): Promise<Edge[]>`.
- `addEdge` returns `false` when the edge already existed; rejects a self-edge and any edge that would close a cycle with a `DataError`. Endpoints that don't exist yet become `unknown` placeholders (order-independent sync).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import {EdgeStore} from './edge.mts';

async function fresh(): Promise<{db: Database; store: EdgeStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new EdgeStore(db)};
}

describe('EdgeStore', () => {
  it('adds an edge between placeholders and is idempotent', async () => {
    const {db, store} = await fresh();
    assert.equal(await store.addEdge('A', 'B'), true);
    assert.equal(await store.addEdge('A', 'B'), false);
    assert.deepEqual(await store.edges(), [{blocker: 'A', blocked: 'B'}]);
    await db.close();
  });

  it('rejects a self-edge', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.addEdge('A', 'A'),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });

  it('rejects an edge that would close a cycle', async () => {
    const {db, store} = await fresh();
    await store.addEdge('A', 'B');
    await store.addEdge('B', 'C');
    await assert.rejects(
      store.addEdge('C', 'A'),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });

  it('setEdges replaces one direction atomically', async () => {
    const {db, store} = await fresh();
    await store.addEdge('X', 'N');
    await store.setEdges('N', 'blockers', ['Y', 'Z']);
    const blockers = (await store.edges())
      .filter((e) => e.blocked === 'N')
      .map((e) => e.blocker)
      .sort();
    assert.deepEqual(blockers, ['Y', 'Z']);
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/edge.test.mts`
Expected: FAIL — cannot find `./edge.mts`.

- [ ] **Step 3: Write minimal implementation**

`edge.mts`:

```ts
import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import type {Edge} from '../model/types.mts';
import {nodeRef} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/** The blocking DAG. `blocker` blocks `blocked`; any kind may block any other. */
export class EdgeStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async addEdge(blocker: string, blocked: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const added = this.#insert(blocker, blocked);
      if (added) this.#rejectIfCycle(blocked);
      return added;
    });
  }

  async removeEdge(blocker: string, blocked: string): Promise<boolean> {
    return (
      this.#db.run(
        `DELETE FROM edge
         WHERE blocker = (SELECT id FROM node WHERE external_id = ?)
           AND blocked = (SELECT id FROM node WHERE external_id = ?)`,
        [blocker, blocked]
      ) > 0
    );
  }

  /**
   * Replace every edge in one direction of a node with the given set — lets a
   * re-fetch declare "these are now exactly my blockers/blocks" atomically.
   */
  async setEdges(
    node: string,
    direction: 'blockers' | 'blocks',
    others: readonly string[]
  ): Promise<void> {
    await this.#db.transaction(() => {
      const nodeId = nodeRef(this.#db, node);
      const column = direction === 'blockers' ? 'blocked' : 'blocker';
      this.#db.run(`DELETE FROM edge WHERE ${column} = ?`, [nodeId]);
      for (const other of others) {
        if (direction === 'blockers') this.#insert(other, node);
        else this.#insert(node, other);
      }
      this.#rejectIfCycle(node);
    });
  }

  async edges(): Promise<Edge[]> {
    return this.#db
      .all(
        `SELECT bn.external_id AS blocker, dn.external_id AS blocked
         FROM edge e
         JOIN node bn ON bn.id = e.blocker
         JOIN node dn ON dn.id = e.blocked`
      )
      .map((row) => ({blocker: String(row.blocker), blocked: String(row.blocked)}));
  }

  #insert(blocker: string, blocked: string): boolean {
    ensure(
      blocker !== blocked,
      () =>
        new DataError(`a node cannot block itself (${blocker})`, {
          hint: 'a self-edge is an illegal one-node cycle.',
        })
    );
    const blockerId = nodeRef(this.#db, blocker);
    const blockedId = nodeRef(this.#db, blocked);
    return (
      this.#db.run(
        'INSERT INTO edge (blocker, blocked) VALUES (?, ?) ON CONFLICT DO NOTHING',
        [blockerId, blockedId]
      ) > 0
    );
  }

  /**
   * Throw (rolling back the transaction) if `node` now sits on a cycle. A cycle
   * can only have appeared via an edge just written through `node`, so checking
   * reachability from it alone suffices. Walked by a recursive CTE.
   */
  #rejectIfCycle(externalId: string): void {
    const onCycle = this.#db.get(
      `WITH RECURSIVE reach(id) AS (
         SELECT blocked FROM edge
         WHERE blocker = (SELECT id FROM node WHERE external_id = ?)
         UNION
         SELECT e.blocked FROM edge e JOIN reach r ON e.blocker = r.id
       )
       SELECT 1 FROM reach
       WHERE id = (SELECT id FROM node WHERE external_id = ?) LIMIT 1`,
      [externalId, externalId]
    );
    ensure(
      onCycle === undefined,
      () =>
        new DataError(
          `that edge would create a dependency cycle through ${externalId}`,
          {
            hint: 'remove the opposing edge first, or fix the dependency direction.',
          }
        )
    );
  }
}

/* eslint-enable @typescript-eslint/require-await */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/stores/edge.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/stores/edge.mts plugins/dispatch/src/lib/stores/edge.test.mts
git commit -m "feat: add EdgeStore with cycle rejection"
```

---

### Task 11: SessionStore

**Files:**
- Create: `plugins/dispatch/src/lib/stores/session.mts`
- Test: `plugins/dispatch/src/lib/stores/session.test.mts`

**Interfaces:**
- Consumes: `Database` (`../db/database.mts`), `type Session` (`../model/types.mts`).
- Produces: `class SessionStore` with:
  - `register(s: {id: string; host?: string | null; pid?: number | null; startedAt: string; heartbeatAt: string}): Promise<void>`
  - `heartbeat(id: string, at: string): Promise<boolean>`
  - `close(id: string): Promise<boolean>` — delete the session (claims/slots cascade)
  - `sweepStale(now: string, windowSeconds: number): Promise<number>` — delete sessions whose heartbeat is older than the window; returns how many were removed
  - `getSession(id: string): Promise<Session | null>`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {SessionStore} from './session.mts';

async function fresh(): Promise<{db: Database; store: SessionStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new SessionStore(db)};
}

describe('SessionStore', () => {
  it('registers and reads a session', async () => {
    const {db, store} = await fresh();
    await store.register({
      id: 's1',
      host: 'mac',
      pid: 42,
      startedAt: '2026-07-31T00:00:00.000Z',
      heartbeatAt: '2026-07-31T00:00:00.000Z',
    });
    assert.equal((await store.getSession('s1'))?.host, 'mac');
    await db.close();
  });

  it('close cascades the session\'s claims and slots', async () => {
    const {db, store} = await fresh();
    await store.register({
      id: 's1',
      startedAt: '2026-07-31T00:00:00.000Z',
      heartbeatAt: '2026-07-31T00:00:00.000Z',
    });
    db.run("INSERT INTO node (external_id, kind) VALUES ('T1','ticket')");
    const nid = Number(db.get("SELECT id FROM node WHERE external_id='T1'")?.id);
    db.run(
      "INSERT INTO claim (node_id, session_id, claimed_at) VALUES (?, 's1', '2026-07-31T00:00:00Z')",
      [nid]
    );
    db.run(
      "INSERT INTO slot (session_id, actor, acquired_at) VALUES ('s1', 'w1', '2026-07-31T00:00:00Z')"
    );
    assert.equal(await store.close('s1'), true);
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM claim')?.n), 0);
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM slot')?.n), 0);
    await db.close();
  });

  it('sweepStale removes only sessions past the window', async () => {
    const {db, store} = await fresh();
    await store.register({
      id: 'old',
      startedAt: '2026-07-31T00:00:00.000Z',
      heartbeatAt: '2026-07-31T00:00:00.000Z',
    });
    await store.register({
      id: 'fresh',
      startedAt: '2026-07-31T00:09:30.000Z',
      heartbeatAt: '2026-07-31T00:09:30.000Z',
    });
    // 10-minute window, "now" is 00:10:00 → 'old' is 600s stale, 'fresh' is 30s.
    const removed = await store.sweepStale('2026-07-31T00:10:00.000Z', 300);
    assert.equal(removed, 1);
    assert.equal(await store.getSession('old'), null);
    assert.ok(await store.getSession('fresh'));
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/session.test.mts`
Expected: FAIL — cannot find `./session.mts`.

- [ ] **Step 3: Write minimal implementation**

`session.mts`:

```ts
import type {Database} from '../db/database.mts';
import type {Session} from '../model/types.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/**
 * Sessions: one row per live MCP server process, the only liveness primitive.
 * Claims and slots reference a session and cascade when it is deleted — on a
 * clean `close`, or when `sweepStale` reaps a process whose heartbeat stopped.
 */
export class SessionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async register(session: {
    id: string;
    host?: string | null;
    pid?: number | null;
    startedAt: string;
    heartbeatAt: string;
  }): Promise<void> {
    this.#db.run(
      `INSERT INTO session (id, host, pid, started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         host = excluded.host, pid = excluded.pid,
         heartbeat_at = excluded.heartbeat_at`,
      [
        session.id,
        session.host ?? null,
        session.pid ?? null,
        session.startedAt,
        session.heartbeatAt,
      ]
    );
  }

  async heartbeat(id: string, at: string): Promise<boolean> {
    return this.#db.run('UPDATE session SET heartbeat_at = ? WHERE id = ?', [
      at,
      id,
    ]) > 0;
  }

  /** Clean exit: delete the session; its claims and slots cascade. */
  async close(id: string): Promise<boolean> {
    return this.#db.run('DELETE FROM session WHERE id = ?', [id]) > 0;
  }

  /**
   * Reap sessions whose heartbeat is older than `windowSeconds` before `now`.
   * The staleness sweep is the only place liveness is judged by age. Returns the
   * number of sessions removed (their claims and slots cascade).
   */
  async sweepStale(now: string, windowSeconds: number): Promise<number> {
    return this.#db.run(
      'DELETE FROM session WHERE unixepoch(?) - unixepoch(heartbeat_at) > ?',
      [now, windowSeconds]
    );
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.#db.get(
      `SELECT id, host, pid, started_at, heartbeat_at
       FROM session WHERE id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {
      id: String(row.id),
      host: row.host === null ? null : String(row.host),
      pid: row.pid === null ? null : Number(row.pid),
      startedAt: String(row.started_at),
      heartbeatAt: String(row.heartbeat_at),
    };
  }
}

/* eslint-enable @typescript-eslint/require-await */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/stores/session.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/stores/session.mts plugins/dispatch/src/lib/stores/session.test.mts
git commit -m "feat: add SessionStore with cascade cleanup and staleness sweep"
```

---

### Task 12: CoordinationStore (claims, slots, outcomes)

**Files:**
- Create: `plugins/dispatch/src/lib/stores/coordination.mts`
- Test: `plugins/dispatch/src/lib/stores/coordination.test.mts`

**Interfaces:**
- Consumes: `Database`, `findNode` (`./materialize.mts`), `isOutcome`/`OUTCOMES` (`../model/status.mts`), `type OutcomeKind`/`Outcome`/`Claim` (`../model/types.mts`), `DataError`/`ensure` (`../errors/index.mts`).
- Produces: `class CoordinationStore` with:
  - `type ClaimResult = {outcome: 'claimed' | 'refreshed' | 'held' | 'unknown-node'; heldBy?: string}`
  - `claim(input: {node: string; session: string; actor?: string; worktree?: string; branch?: string; claimedAt: string}): Promise<ClaimResult>` — insert if free, refresh if the caller's own session holds it, `held` if another session does, `unknown-node` if the node doesn't exist.
  - `release(node: string, session: string): Promise<'released' | 'absent' | 'not-yours'>`
  - `acquireSlot(input: {session: string; actor: string; max: number; acquiredAt: string}): Promise<'acquired' | 'refreshed' | 'full'>` — global `COUNT(*)` bound; idempotent per `(session, actor)`.
  - `releaseSlot(session: string, actor: string): Promise<boolean>`
  - `slotCount(): Promise<number>`
  - `recordOutcome(report: {node: string; outcome: OutcomeKind; retryable: boolean | null; detail: string | null; recordedAt: string}, holder: {session: string; actor?: string}): Promise<void>` — writes the outcome and releases the holder's claim on the node and its slot, in one transaction.
  - `getOutcome(node: string): Promise<Outcome | null>`
- `recordOutcome` rejects `retryable` set with any outcome other than `failed` (a `DataError`).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import {CoordinationStore} from './coordination.mts';

async function fresh(): Promise<{db: Database; store: CoordinationStore}> {
  const db = await Database.open(':memory:');
  db.run("INSERT INTO node (external_id, kind) VALUES ('T1','ticket')");
  db.run(
    "INSERT INTO session (id, started_at, heartbeat_at) VALUES ('s1','2026-07-31T00:00:00Z','2026-07-31T00:00:00Z')"
  );
  db.run(
    "INSERT INTO session (id, started_at, heartbeat_at) VALUES ('s2','2026-07-31T00:00:00Z','2026-07-31T00:00:00Z')"
  );
  return {db, store: new CoordinationStore(db)};
}

describe('CoordinationStore claims', () => {
  it('claims a free node, refreshes its own, refuses another session', async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    assert.equal((await store.claim({node: 'T1', session: 's1', claimedAt: at})).outcome, 'claimed');
    assert.equal((await store.claim({node: 'T1', session: 's1', claimedAt: at})).outcome, 'refreshed');
    const held = await store.claim({node: 'T1', session: 's2', claimedAt: at});
    assert.equal(held.outcome, 'held');
    assert.equal(held.heldBy, 's1');
    await db.close();
  });

  it('reports an unknown node', async () => {
    const {db, store} = await fresh();
    assert.equal(
      (await store.claim({node: 'NOPE', session: 's1', claimedAt: '2026-07-31T00:00:00Z'})).outcome,
      'unknown-node'
    );
    await db.close();
  });

  it('release refuses another session and is idempotent', async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    await store.claim({node: 'T1', session: 's1', claimedAt: at});
    assert.equal(await store.release('T1', 's2'), 'not-yours');
    assert.equal(await store.release('T1', 's1'), 'released');
    assert.equal(await store.release('T1', 's1'), 'absent');
    await db.close();
  });
});

describe('CoordinationStore slots', () => {
  it('bounds acquisition and is idempotent per actor', async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    assert.equal(await store.acquireSlot({session: 's1', actor: 'w1', max: 1, acquiredAt: at}), 'acquired');
    assert.equal(await store.acquireSlot({session: 's1', actor: 'w1', max: 1, acquiredAt: at}), 'refreshed');
    assert.equal(await store.slotCount(), 1);
    assert.equal(await store.acquireSlot({session: 's2', actor: 'w2', max: 1, acquiredAt: at}), 'full');
    assert.equal(await store.releaseSlot('s1', 'w1'), true);
    assert.equal(await store.acquireSlot({session: 's2', actor: 'w2', max: 1, acquiredAt: at}), 'acquired');
    await db.close();
  });
});

describe('CoordinationStore recordOutcome', () => {
  it('writes the outcome and releases the holder\'s claim and slot', async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    await store.claim({node: 'T1', session: 's1', actor: 'c1', claimedAt: at});
    await store.acquireSlot({session: 's1', actor: 'c1', max: 4, acquiredAt: at});
    await store.recordOutcome(
      {node: 'T1', outcome: 'delivered', retryable: null, detail: null, recordedAt: at},
      {session: 's1', actor: 'c1'}
    );
    assert.equal((await store.getOutcome('T1'))?.outcome, 'delivered');
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM claim')?.n), 0);
    assert.equal(await store.slotCount(), 0);
    await db.close();
  });

  it('rejects retryable on a non-failed outcome', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.recordOutcome(
        {node: 'T1', outcome: 'verified', retryable: true, detail: null, recordedAt: '2026-07-31T00:00:00Z'},
        {session: 's1'}
      ),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/coordination.test.mts`
Expected: FAIL — cannot find `./coordination.mts`.

- [ ] **Step 3: Write minimal implementation**

`coordination.mts`:

```ts
import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import {isOutcome, OUTCOMES} from '../model/status.mts';
import type {Outcome, OutcomeKind} from '../model/types.mts';
import {findNode} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export interface ClaimResult {
  outcome: 'claimed' | 'refreshed' | 'held' | 'unknown-node';
  /** The session that holds it when the outcome is `held`. */
  heldBy?: string;
}

/**
 * The runtime coordination a live unit holds and reports: claims (locks), slots
 * (compute capacity), and outcomes (final reports). Grouped because they are
 * transactionally linked — recording an outcome releases the reporter's claim
 * and slot in the same write.
 */
export class CoordinationStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async claim(input: {
    node: string;
    session: string;
    actor?: string;
    worktree?: string;
    branch?: string;
    claimedAt: string;
  }): Promise<ClaimResult> {
    return this.#db.transaction(() => {
      const node = findNode(this.#db, input.node);
      if (node === null) return {outcome: 'unknown-node'};
      const existing = this.#db.get(
        'SELECT session_id FROM claim WHERE node_id = ?',
        [node.id]
      );
      if (existing !== undefined && existing.session_id !== input.session) {
        return {outcome: 'held', heldBy: String(existing.session_id)};
      }
      this.#db.run(
        `INSERT INTO claim (node_id, session_id, actor, worktree, branch, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           session_id = excluded.session_id, actor = excluded.actor,
           worktree = excluded.worktree, branch = excluded.branch,
           claimed_at = excluded.claimed_at`,
        [
          node.id,
          input.session,
          input.actor ?? null,
          input.worktree ?? null,
          input.branch ?? null,
          input.claimedAt,
        ]
      );
      return {outcome: existing === undefined ? 'claimed' : 'refreshed'};
    });
  }

  async release(
    node: string,
    session: string
  ): Promise<'released' | 'absent' | 'not-yours'> {
    return this.#db.transaction(() => {
      const row = this.#db.get(
        `SELECT session_id FROM claim
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)`,
        [node]
      );
      if (row === undefined) return 'absent';
      if (row.session_id !== session) return 'not-yours';
      this.#db.run(
        'DELETE FROM claim WHERE node_id = (SELECT id FROM node WHERE external_id = ?)',
        [node]
      );
      return 'released';
    });
  }

  async claims(): Promise<
    {node: string; session: string; actor: string | null}[]
  > {
    return this.#db
      .all(
        `SELECT n.external_id AS node, c.session_id AS session, c.actor
         FROM claim c JOIN node n ON n.id = c.node_id`
      )
      .map((row) => ({
        node: String(row.node),
        session: String(row.session),
        actor: row.actor === null ? null : String(row.actor),
      }));
  }

  /**
   * Acquire a compute slot, bounded globally by `max`. Idempotent per
   * `(session, actor)` via the UNIQUE constraint: a re-acquire refreshes.
   */
  async acquireSlot(input: {
    session: string;
    actor: string;
    max: number;
    acquiredAt: string;
  }): Promise<'acquired' | 'refreshed' | 'full'> {
    return this.#db.transaction(() => {
      const held = this.#db.get(
        'SELECT 1 FROM slot WHERE session_id = ? AND actor = ?',
        [input.session, input.actor]
      );
      if (held !== undefined) {
        this.#db.run(
          'UPDATE slot SET acquired_at = ? WHERE session_id = ? AND actor = ?',
          [input.acquiredAt, input.session, input.actor]
        );
        return 'refreshed';
      }
      const count = Number(this.#db.get('SELECT COUNT(*) AS n FROM slot')?.n ?? 0);
      if (count >= input.max) return 'full';
      this.#db.run(
        'INSERT INTO slot (session_id, actor, acquired_at) VALUES (?, ?, ?)',
        [input.session, input.actor, input.acquiredAt]
      );
      return 'acquired';
    });
  }

  async releaseSlot(session: string, actor: string): Promise<boolean> {
    return this.#db.run(
      'DELETE FROM slot WHERE session_id = ? AND actor = ?',
      [session, actor]
    ) > 0;
  }

  async slotCount(): Promise<number> {
    return Number(this.#db.get('SELECT COUNT(*) AS n FROM slot')?.n ?? 0);
  }

  /**
   * Record a unit's final report on a node, releasing its claim and slot in the
   * same transaction — the artifact proves its writer exited. One row per node;
   * a later pass's report replaces it.
   */
  async recordOutcome(
    report: {
      node: string;
      outcome: OutcomeKind;
      retryable: boolean | null;
      detail: string | null;
      recordedAt: string;
    },
    holder: {session: string; actor?: string}
  ): Promise<void> {
    ensure(
      isOutcome(report.outcome),
      () =>
        new DataError(`"${report.outcome}" is not an outcome`, {
          hint: `use one of: ${OUTCOMES.join(', ')}.`,
        })
    );
    ensure(
      report.retryable === null || report.outcome === 'failed',
      () =>
        new DataError('retryable is meaningful only with outcome "failed"', {
          hint: 'drop retryable, or report the failure as outcome "failed".',
        })
    );
    await this.#db.transaction(() => {
      const node = findNode(this.#db, report.node);
      ensure(
        node !== null,
        () =>
          new DataError(`no node "${report.node}" to record an outcome on`, {
            hint: 'an outcome is recorded on a node the graph already holds.',
          })
      );
      this.#db.run(
        `INSERT INTO outcome (node_id, outcome, retryable, detail, recorded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           outcome = excluded.outcome, retryable = excluded.retryable,
           detail = excluded.detail, recorded_at = excluded.recorded_at`,
        [
          node.id,
          report.outcome,
          report.retryable === null ? null : report.retryable ? 1 : 0,
          report.detail,
          report.recordedAt,
        ]
      );
      this.#db.run('DELETE FROM claim WHERE node_id = ? AND session_id = ?', [
        node.id,
        holder.session,
      ]);
      if (holder.actor !== undefined) {
        this.#db.run('DELETE FROM slot WHERE session_id = ? AND actor = ?', [
          holder.session,
          holder.actor,
        ]);
      }
    });
  }

  async getOutcome(node: string): Promise<Outcome | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS node, o.outcome, o.retryable, o.detail, o.recorded_at
       FROM outcome o JOIN node n ON n.id = o.node_id
       WHERE n.external_id = ?`,
      [node]
    );
    if (row === undefined) return null;
    return {
      node: String(row.node),
      outcome: row.outcome as OutcomeKind,
      retryable: row.retryable === null ? null : row.retryable === 1,
      detail: row.detail === null ? null : String(row.detail),
      recordedAt: String(row.recorded_at),
    };
  }
}

/* eslint-enable @typescript-eslint/require-await */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/stores/coordination.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/stores/coordination.mts plugins/dispatch/src/lib/stores/coordination.test.mts
git commit -m "feat: add CoordinationStore for claims, slots, and outcomes"
```

---

### Task 13: CursorStore

**Files:**
- Create: `plugins/dispatch/src/lib/stores/cursor.mts`
- Test: `plugins/dispatch/src/lib/stores/cursor.test.mts`

**Interfaces:**
- Consumes: `Database` (`../db/database.mts`).
- Produces: `class CursorStore` with `getCursor(source: string): Promise<string | null>`, `setCursor(source: string, value: string): Promise<void>`, `clearCursor(source: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {CursorStore} from './cursor.mts';

async function fresh(): Promise<{db: Database; store: CursorStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new CursorStore(db)};
}

describe('CursorStore', () => {
  it('sets, overwrites, reads, and clears a cursor', async () => {
    const {db, store} = await fresh();
    assert.equal(await store.getCursor('linear'), null);
    await store.setCursor('linear', '2026-07-31T00:00:00Z');
    assert.equal(await store.getCursor('linear'), '2026-07-31T00:00:00Z');
    await store.setCursor('linear', '2026-07-31T01:00:00Z');
    assert.equal(await store.getCursor('linear'), '2026-07-31T01:00:00Z');
    assert.equal(await store.clearCursor('linear'), true);
    assert.equal(await store.clearCursor('linear'), false);
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/stores/cursor.test.mts`
Expected: FAIL — cannot find `./cursor.mts`.

- [ ] **Step 3: Write minimal implementation**

`cursor.mts`:

```ts
import type {Database} from '../db/database.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/** Opaque per-source delta-sync cursors persisted between ticks. */
export class CursorStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async getCursor(source: string): Promise<string | null> {
    const row = this.#db.get('SELECT value FROM cursor WHERE source = ?', [
      source,
    ]);
    return row === undefined ? null : String(row.value);
  }

  async setCursor(source: string, value: string): Promise<void> {
    this.#db.run(
      `INSERT INTO cursor (source, value) VALUES (?, ?)
       ON CONFLICT(source) DO UPDATE SET value = excluded.value`,
      [source, value]
    );
  }

  async clearCursor(source: string): Promise<boolean> {
    return this.#db.run('DELETE FROM cursor WHERE source = ?', [source]) > 0;
  }
}

/* eslint-enable @typescript-eslint/require-await */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/stores/cursor.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/stores/cursor.mts plugins/dispatch/src/lib/stores/cursor.test.mts
git commit -m "feat: add CursorStore"
```

---

### Task 14: Barrels, folder docs, and full verification

**Files:**
- Create: `plugins/dispatch/src/lib/db/index.mts`
- Create: `plugins/dispatch/src/lib/db/CLAUDE.md`
- Create: `plugins/dispatch/src/lib/model/index.mts`
- Create: `plugins/dispatch/src/lib/model/CLAUDE.md`
- Create: `plugins/dispatch/src/lib/stores/index.mts`
- Create: `plugins/dispatch/src/lib/stores/CLAUDE.md`

**Interfaces:**
- Produces: barrel re-exports so consumers import `../db/index.mts`, `../model/index.mts`, `../stores/index.mts`. No new behavior.

- [ ] **Step 1: Write the barrels**

`db/index.mts`:

```ts
export * from './database.mts';
export * from './schema.mts';
export * from './time.mts';
```

`model/index.mts`:

```ts
export * from './status.mts';
export * from './types.mts';
```

`stores/index.mts`:

```ts
export * from './materialize.mts';
export * from './project.mts';
export * from './milestone.mts';
export * from './ticket.mts';
export * from './pr.mts';
export * from './edge.mts';
export * from './session.mts';
export * from './coordination.mts';
export * from './cursor.mts';
```

- [ ] **Step 2: Write the folder CLAUDE.md files**

`db/CLAUDE.md`:

```markdown
# db

Low-level SQLite: the connection and the schema. No domain knowledge lives here.

- `database.mts` — `Database`: `open` (pragmas incl. `foreign_keys = ON`, schema
  bootstrap, version refusal), `transaction` (BEGIN IMMEDIATE), `guard` (maps a
  locked/unwritable DB to `EnvironmentError`), and `run`/`get`/`all`.
- `schema.mts` — the `SCHEMA` DDL and `SCHEMA_VERSION`. STRICT tables; the DB is
  a rebuildable cache, so a version mismatch is refused rather than migrated.
- `time.mts` — `nowIso` and `assertInstant` (RFC 3339 validation). Timestamps are
  TEXT ISO-8601 UTC.
```

`model/CLAUDE.md`:

```markdown
# model

Pure domain types and vocabulary. No SQL.

- `status.mts` — the tracker-neutral enums (`Status`, `TargetKind`, `PrOrigin`,
  `Kind`, `OutcomeKind`), their guards, `GROUP_OF`, and `RESOLVED_STATUSES`.
- `types.mts` — the domain model interfaces (`Project`, `Ticket`, `Pr`, …) the
  stores map rows to and from.
```

`stores/CLAUDE.md`:

```markdown
# stores

One store per concept over the shared `Database`. A store is organized around a
concept, not a single table: an operation may write several tables atomically.

- `materialize.mts` — shared node create/promote (placeholder → concrete kind),
  with the id-kind conflict check. Used by every write store.
- `project` / `milestone` / `ticket` / `pr` — per-kind upsert/remove/read.
- `edge` — the blocking DAG: add/remove/setEdges with cycle rejection.
- `session` — session lifecycle; claims and slots cascade off it.
- `coordination` — claims, slots, and outcomes (transactionally linked).
- `cursor` — delta-sync cursors.

The derived read-model (frontier, classification, milestone state, anomalies) and
`recordReview` are not here yet — see the Plan 2 follow-up.
```

- [ ] **Step 3: Verify the whole suite, types, and lint**

Run: `npm test`
Expected: PASS — every `*.test.mts` in this plan green.

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors (the `require-await` disable comments cover the async-facade files).

- [ ] **Step 4: Commit**

```bash
git add plugins/dispatch/src/lib/db/index.mts plugins/dispatch/src/lib/db/CLAUDE.md plugins/dispatch/src/lib/model/index.mts plugins/dispatch/src/lib/model/CLAUDE.md plugins/dispatch/src/lib/stores/index.mts plugins/dispatch/src/lib/stores/CLAUDE.md
git commit -m "chore: add persistence layer barrels and folder docs"
```

---

## Plan 2 (follow-up, not in this plan)

The derived read-model over this storage layer, to be planned separately:

- `GraphStore` — `classifiedNodes` (effective-blocking over the DAG, kind-aware
  resolution: tickets by status, milestones by recorded review), `frontier` /
  `dispatchQueue` (ranked available tickets/PRs), `milestoneStates`
  (ready-for-review / review-recorded), `anomalies` (cycles, dangling edges,
  cross-project), `counts`, and node/edge lookups. Port and adapt the logic from
  `plugins/dispatch/cli/lib/graph/derive.mts` and `queries.mts`.
- `MilestoneStore.recordReview` — record a milestone review over its current
  member set (the tickets blocking it), releasing the review agent's claim.
