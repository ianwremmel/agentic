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
