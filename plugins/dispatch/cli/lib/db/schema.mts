import {ROLES, TARGET_KINDS} from '../graph/roles.mts';

/**
 * Bumped on any change an existing database file cannot absorb. `Database.open`
 * refuses a file whose recorded version differs — see `database.mts`.
 */
export const SCHEMA_VERSION = 4;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * Everything dispatch persists. The graph is today's only tenant, but the
 * database will hold more, so the schema is one document and the constraints
 * live here rather than in the code that writes the rows:
 *
 * - `node` is the base identity table. Tasks and milestones are satellite
 *   tables keyed by `node.id`, so edges, claims, and reviews can all reference
 *   one id space with real foreign keys, and a `LEFT OUTER JOIN` from `node`
 *   reads any mix of them in one query.
 * - `node.id` is an INTEGER for cheap joins; the tracker's identifier lives in
 *   `external_id` and is the only id the CLI's input and output ever speak.
 * - `kind` says which satellite a node has: exactly one of `task`/`milestone`,
 *   or `unknown` for a placeholder — an id named by an edge before it has been
 *   fetched. Placeholders are what let a delta write edges in any order under
 *   foreign keys; a node's kind is promoted when its satellite row is written.
 * - Timestamps are epoch milliseconds (INTEGER), so recency comparisons —
 *   claim staleness, review invalidation — are plain SQL arithmetic instead of
 *   string comparisons that break across timezone offsets.
 * - `review_member` pins a review to the member set it covered by external id,
 *   deliberately without a node FK: the review is a historical fact about
 *   tracker ids, and must not mutate when a member is later deleted.
 * - `labels` is a JSON array in a TEXT column: labels are read and written
 *   whole with their task and never queried across tasks.
 * - `outcome` is a coordinator's final report on a node — the write that lets
 *   the scheduler serve re-dispatch passes (verify, finalize, retry) instead of
 *   the orchestrator reconciling files. One row per node; a later run's report
 *   replaces it.
 * - `slot` is the compute-slot ledger (§2.6): one row per held slot, bounded by
 *   the config's maxParallel at acquire time, reclaimed when its heartbeat goes
 *   stale.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS project (
  id          INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  declared    INTEGER NOT NULL DEFAULT 0 CHECK (declared IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS node (
  id          INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('task', 'milestone', 'unknown'))
) STRICT;

CREATE TABLE IF NOT EXISTS task (
  node_id           INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  project_id        INTEGER NOT NULL REFERENCES project(id),
  url               TEXT NOT NULL,
  title             TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN (${quoted(ROLES)})),
  milestone_id      INTEGER REFERENCES node(id),
  target_kind       TEXT NOT NULL CHECK (target_kind IN (${quoted(TARGET_KINDS)})),
  human_interactive INTEGER NOT NULL CHECK (human_interactive IN (0, 1)),
  injected          INTEGER NOT NULL CHECK (injected IN (0, 1)),
  priority          REAL,
  branch_hint       TEXT,
  labels            TEXT NOT NULL,
  updated_at_ms     INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS milestone (
  node_id    INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES project(id),
  name       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS edge (
  blocker INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  blocked INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker, blocked),
  CHECK (blocker <> blocked)
) STRICT;

CREATE TABLE IF NOT EXISTS claim (
  node_id         INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  agent           TEXT NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS review (
  milestone_id   INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  recorded_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS review_member (
  milestone_id       INTEGER NOT NULL REFERENCES review(milestone_id) ON DELETE CASCADE,
  member_external_id TEXT NOT NULL,
  PRIMARY KEY (milestone_id, member_external_id)
) STRICT;

CREATE TABLE IF NOT EXISTS outcome (
  node_id        INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  outcome        TEXT NOT NULL CHECK (outcome IN
    ('verified', 'canceled', 'delivered', 'human-blocked', 'decomposed', 'failed')),
  retryable      INTEGER CHECK (retryable IN (0, 1)),
  detail         TEXT,
  recorded_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS slot (
  agent           TEXT PRIMARY KEY,
  heartbeat_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cursor (
  source TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS task_project ON task (project_id);
CREATE INDEX IF NOT EXISTS task_milestone ON task (milestone_id);
CREATE INDEX IF NOT EXISTS edge_blocked ON edge (blocked);
`;
