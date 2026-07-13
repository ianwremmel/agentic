export const SCHEMA_VERSION = 1;

/**
 * `labels` is a JSON array in a TEXT column: labels are read and written whole
 * with their node and are never queried across nodes, so a join table would buy
 * nothing.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS milestone (
  id         TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  name       TEXT NOT NULL,
  sort_order REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS node (
  id                TEXT PRIMARY KEY,
  project           TEXT NOT NULL,
  url               TEXT NOT NULL,
  title             TEXT NOT NULL,
  role              TEXT NOT NULL,
  milestone         TEXT,
  target_kind       TEXT NOT NULL,
  human_interactive INTEGER NOT NULL,
  injected          INTEGER NOT NULL,
  priority          INTEGER,
  branch_hint       TEXT,
  labels            TEXT NOT NULL,
  updated_at        TEXT
);

CREATE TABLE IF NOT EXISTS edge (
  blocker TEXT NOT NULL,
  blocked TEXT NOT NULL,
  PRIMARY KEY (blocker, blocked)
);

CREATE TABLE IF NOT EXISTS exclusion (
  id   TEXT PRIMARY KEY,
  kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review (
  milestone   TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (milestone, fingerprint)
);

CREATE TABLE IF NOT EXISTS cursor (
  source TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS node_project ON node (project);
CREATE INDEX IF NOT EXISTS edge_blocked ON edge (blocked);
CREATE INDEX IF NOT EXISTS edge_blocker ON edge (blocker);
`;
