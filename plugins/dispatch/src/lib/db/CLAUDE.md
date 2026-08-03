# db

Low-level SQLite: the connection and the schema. No domain knowledge lives here.

- `database.mts` — `Database`: `open` (pragmas incl. `foreign_keys = ON`, schema
  bootstrap, version refusal), `transaction` (BEGIN IMMEDIATE), `guard` (maps a
  locked/unwritable DB to `EnvironmentError`), and `run`/`get`/`all`.
- `schema.mts` — the `SCHEMA` DDL and `SCHEMA_VERSION`. STRICT tables; the DB is
  a rebuildable cache, so a version mismatch is refused rather than migrated.
- `time.mts` — `nowIso` and `assertInstant` (RFC 3339 validation). Timestamps are
  TEXT ISO-8601 UTC.
- `with-database.mts` — `withDatabase` (open/close around a command body),
  `resolveDbPath` (flag → `DISPATCH_DB` → XDG), and the shared `DB_OPTION`.
