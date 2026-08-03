# schedule

The server's deterministic scheduling half.

- `scheduler.mts` — `Scheduler.tick(now)`: heartbeat and sweep, then (only
  once the session is acked) claim-then-emit over the dispatch queue up to
  free compute capacity, milestone-review orders under milestone-keyed claims,
  and the once-per-episode condition orders (`notice` table). Returns orders;
  never touches the channel, so it tests without one.
- `tick.mts` — `runServerTick`: opens the DB, runs the scheduler, pushes the
  orders, and keeps the probe/ack handshake alive on a capped backoff.
- `correlate.mts` — `resolveSession`: an explicit registry id, else the one
  live server carrying the caller's Claude session id.
