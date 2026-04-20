# scripts/buildkite/

Standalone Buildkite CLI helpers. Each script is executed directly (not
sourced) and wraps the `bk` CLI with retry logic plus jq-based output
shaping. They exist so the agent has stable, scriptable access to CI
state without depending on a Buildkite MCP server.

These scripts are **not** wired into `../orchestrate`'s dispatcher —
they're invoked directly by skills, agents, or other scripts.

## Scripts

| Script             | What it does                                                                                                         |
|--------------------|----------------------------------------------------------------------------------------------------------------------|
| `bk-failed-jobs`   | Lists `failed` and `broken` jobs from a build as a JSON array of `{name, state, id, retried}`.                       |
| `bk-failure-info`  | Combines build annotations with the list of JUnit XML artifacts for a build into one JSON blob — the inputs needed for failure analysis. |
| `bk-job-log`       | Fetches the last N lines of a specific job's log. Defaults to the last 200 lines; override with `--tail N`.          |

## Conventions

- Each script `set -euo pipefail` at the top.
- Each script sources `../lib/_retry` and wraps every `bk` call in
  `retry 3 5 ...` so transient API failures don't kill the agent.
- Output is JSON when there's structured data, raw text for log tails.
- Pipeline / org are currently hard-coded to `ianremmelllc/apps`; lift
  to env vars when this plugin is consumed by other repos.

## Tests

```sh
cd plugins/pull-requests
bats scripts/buildkite/*.bats
```

Tests stub the `bk` CLI as a bash function and invoke the scripts'
internal functions directly.
