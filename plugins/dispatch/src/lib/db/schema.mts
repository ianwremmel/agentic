/**
 * Bumped on any change an existing database file cannot absorb. `Database.open`
 * refuses a file whose recorded version differs. The database is a rebuildable
 * cache (the graph re-derives from a full sync; sessions/claims/slots are pure
 * runtime state), so a bump's recovery is "delete the file and re-sync" — there
 * is no migration machinery.
 */
export const SCHEMA_VERSION = 4;

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
  name    TEXT NOT NULL,
  source  TEXT
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
  id                TEXT PRIMARY KEY,
  host              TEXT,
  pid               INTEGER,
  claude_session_id TEXT,
  acked_at          TEXT,
  started_at        TEXT NOT NULL,
  heartbeat_at      TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS watch (
  node_id     INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL CHECK (reason IN ('ci','review','merge')),
  state       TEXT NOT NULL DEFAULT 'watching' CHECK (state IN ('watching','fired')),
  fingerprint TEXT,
  interval_s  INTEGER NOT NULL CHECK (interval_s > 0),
  checked_at  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
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

/* A refresh must outlive the staleness sweep that reaps its session, which is the case takeover exists for. */
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

/* One row per condition order in flight: fires once while its condition holds,
   cleared when the condition lapses so a new episode can fire again. */
CREATE TABLE IF NOT EXISTS notice (
  kind       TEXT NOT NULL CHECK (kind IN ('park_human_blocked','alert_failure','project_complete')),
  node       TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  PRIMARY KEY (kind, node)
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

CREATE INDEX IF NOT EXISTS ticket_project      ON ticket (project_id);
CREATE INDEX IF NOT EXISTS milestone_project   ON milestone (project_id);
CREATE INDEX IF NOT EXISTS pr_ticket           ON pr (ticket_id);
CREATE INDEX IF NOT EXISTS edge_blocked        ON edge (blocked);
CREATE INDEX IF NOT EXISTS claim_session       ON claim (session_id);
CREATE INDEX IF NOT EXISTS fetch_request_open  ON fetch_request (source, resolution);
`;
