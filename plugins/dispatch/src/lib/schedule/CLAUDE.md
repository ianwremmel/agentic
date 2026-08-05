# schedule

The server's deterministic scheduling half.

- `scheduler.mts` — `Scheduler.tick(now)`: heartbeat and sweep, then (only
  once the session is acked) one admission budget — `max-parallel` minus
  in-flight claims and slots — spent on milestone-review orders first, then
  claim-then-emit over the dispatch queue, plus the once-per-episode condition
  orders (`notice` table). Returns orders; never touches the channel, so it
  tests without one.
- `tick.mts` — `runServerTick`: runs the scheduler (heartbeat first), polls
  the PR watches (`../watch`) and re-schedules when one fires, delivers owed
  ingest instructions (only once acked), pushes the orders, and keeps the
  probe/ack handshake alive on a capped backoff.
- `correlate.mts` — `resolveSession`: an explicit registry id, else the one
  live server carrying the caller's Claude session id, skipping rows whose
  registered pid is dead on this host.
