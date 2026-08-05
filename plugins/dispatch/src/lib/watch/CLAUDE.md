# watch

Server-side PR waiting: the deterministic half of a worker's "wait for the PR
to change".

- `poll.mts` — `pollWatches(env, {fingerprint})`: fingerprint each due watch
  row and record the observation; a change fires the row, which re-queues its
  item as a `resume` pass. Per-row failures delay that row's retry and log;
  they never fail the pass.
- `github.mts` — `githubFingerprint`: one `gh api graphql` call per PR,
  reduced to a stable string of the structural fields a waiting worker cares
  about (head, state, draft, review decision, comment/review/thread counts,
  check rollup). `updatedAt` is deliberately excluded — it moves on the
  agent's own writes.

The rows live in `stores/watch.mts`; both the server tick and the CLI `tick`
command run the poll.
