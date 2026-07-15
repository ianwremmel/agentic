export const SCHEMA_VERSION = 2;

/**
 * `labels` is a JSON array in a TEXT column: labels are read and written whole
 * with their task and are never queried across tasks, so a join table would buy
 * nothing.
 *
 * Tasks and milestones are separate tables but share one `edge` table — an edge
 * endpoint may be either, which is how a milestone participates in the
 * dependency graph the same way a task does.
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
  id      TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  name    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id                TEXT PRIMARY KEY,
  project           TEXT NOT NULL,
  url               TEXT NOT NULL,
  title             TEXT NOT NULL,
  role              TEXT NOT NULL,
  milestone         TEXT,
  target_kind       TEXT NOT NULL,
  human_interactive INTEGER NOT NULL,
  injected          INTEGER NOT NULL,
  priority          REAL,
  branch_hint       TEXT,
  labels            TEXT NOT NULL,
  updated_at        TEXT
);

CREATE TABLE IF NOT EXISTS edge (
  blocker TEXT NOT NULL,
  blocked TEXT NOT NULL,
  PRIMARY KEY (blocker, blocked)
);

CREATE TABLE IF NOT EXISTS claim (
  id           TEXT PRIMARY KEY,
  agent        TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review (
  milestone   TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cursor (
  source TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS task_project ON task (project);
CREATE INDEX IF NOT EXISTS edge_blocked ON edge (blocked);
CREATE INDEX IF NOT EXISTS edge_blocker ON edge (blocker);
`;
