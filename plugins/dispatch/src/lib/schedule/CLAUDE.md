# schedule

The server's deterministic scheduling half.

- `scheduler.mts` — `Scheduler.tick(now)`: heartbeat and sweep, then (only
  once the session is acked) one admission budget — `max-parallel` minus
  live claims — spent on milestone-review orders first, then
  claim-then-emit over the dispatch queue, plus the once-per-episode condition
  orders (`notice` table). Returns orders; never touches the channel, so it
  tests without one.
- `caps.mts` — `RepoAdmission`: the per-repo caps on open PRs and in-flight
  builds, which bound resources a PR holds while no agent does. Unlike the
  budget, a cap refuses one queue entry and the pass continues — a later entry
  for another repo may still fit.
- `tick.mts` — `runServerTick`: opens the DB, runs the scheduler, pushes the
  orders, and keeps the probe/ack handshake alive on a capped backoff.
- `correlate.mts` — `resolveSession`: an explicit registry id, else the one
  live server carrying the caller's Claude session id.
