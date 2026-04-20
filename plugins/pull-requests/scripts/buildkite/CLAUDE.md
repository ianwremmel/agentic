# scripts/buildkite/

Standalone Buildkite CLI helpers. Each script is executed directly (not
sourced) and wraps the `bk` CLI with retry logic plus jq-based output
shaping. They exist so the agent has stable, scriptable access to CI
state without depending on a Buildkite MCP server.

These scripts are **not** wired into `../orchestrate`'s dispatcher —
they're invoked directly by skills, agents, or other scripts.

## Scripts

All three take `<org>` and `<pipeline>` as the first two positional
arguments — nothing is hardcoded or read from the environment.

| Script             | Usage                                                                                                                                                                                  |
|--------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `bk-failed-jobs`   | `bk-failed-jobs <org> <pipeline> <build>` — JSON array of `{name, state, id, retried}` for failed/broken jobs.                                                                         |
| `bk-failure-info`  | `bk-failure-info <org> <pipeline> <build>` — build annotations plus JUnit XML artifact list, combined into one JSON blob.                                                              |
| `bk-job-log`       | `bk-job-log <org> <pipeline> <build> <job_id> [--lines RANGE] [--refresh]` — caches the full log locally, then slices it per `--lines`. Default range: `-200:` (last 200 lines).       |

### `bk-job-log` range syntax

`RANGE` is one of:

- `N`           — just line N (1-indexed)
- `START:END`   — inclusive range
- `START:`      — `START` through end
- `:END`        — beginning through `END`
- `:`           — whole log

Negative numbers count from the end: `-1` is the last line, `-200` is
the 200th-from-last. So `--lines -200:` is "the last 200 lines".

Logs are cached at `${BK_JOB_LOG_CACHE_DIR:-/tmp/claude/bk-job-log-cache}/<org>-<pipeline>-<build>-<job>.log`.
Pass `--refresh` to re-download instead of using the cache. The cache
dir env var is for tests and custom workflows — scripts should not need
to set it.

## Conventions

- Each script `set -euo pipefail` at the top.
- Each script sources `../lib/_retry.bash` and wraps every `bk` call in
  `retry 3 5 ...` so transient API failures don't kill the agent.
- Output is JSON when there's structured data, raw text for log slices.
- Org and pipeline are always positional arguments — never hardcoded,
  never read from the environment. Callers (skills, agents) own those
  values.

## Tests

```sh
cd plugins/pull-requests
bats scripts/buildkite/*.bats
```

Tests stub the `bk` CLI as a bash function and invoke the scripts'
internal functions directly. `bk-job-log.bats` isolates `BK_JOB_LOG_CACHE_DIR`
to a per-test `mktemp -d` so cache behavior is observable and tests
don't leak state.
