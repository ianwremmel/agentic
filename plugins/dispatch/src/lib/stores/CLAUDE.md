# stores

One store per concept over the shared `Database`. A store is organized around a
concept, not a single table: an operation may write several tables atomically.

- `materialize.mts` — shared node create/promote (placeholder → concrete kind),
  with the id-kind conflict check. Used by every write store.
- `project` / `milestone` / `ticket` / `pr` — per-kind upsert/remove/read.
- `edge` — the blocking DAG: add/remove/setEdges with cycle rejection.
- `session` — session lifecycle; claims cascade off it.
- `coordination` — claims and outcomes (transactionally linked). A claim is
  also the compute grant, so it is the only ledger admissions budget against.
- `cursor` — delta-sync cursors.
- `refresh` — the per-tracker ingest state machine, its pending cursor, and the
  completion-emitted marker.
- `fetch-request` — the durable instruction queue: enqueue, deliver, redeliver,
  resolve, and the open count that decides when a refresh closes.
- `notice` — once-per-episode markers for the scheduler's condition orders.
- `review` — milestone reviews with the member snapshot that expires them.

The derived read-model (frontier, classification, milestone state, anomalies)
lives in `../graph`; the scheduler that acts on it lives in `../schedule`.
