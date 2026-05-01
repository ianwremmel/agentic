# scripts/test-helpers.bash - Shared mocks for bats tests.
# Sourced from every .bats file's setup() AFTER the module under test.

# Match orchestrate's strict mode so behaviors that depend on pipefail
# (e.g. fetch_check_status's `retry ... | jq -s` pipeline) behave the
# same under test as under `./orchestrate`.
set -euo pipefail

# Override retry to invoke the command directly (no sleeping, no loops).
retry() {
  shift 2
  "$@"
}
export -f retry

# Helper: mock gh's --jq behavior by applying jq locally.
# Tests define _gh_raw_data() to return raw JSON for a given arg vector;
# this wrapper extracts the --jq expression from the args and pipes.
_apply_jq_from_args() {
  local jq_expr=""
  local data
  local i=1
  while [[ $i -le $# ]]; do
    if [[ ${!i} == "--jq" ]]; then
      local next=$((i + 1))
      jq_expr="${!next}"
    fi
    i=$((i + 1))
  done

  data=$(_gh_raw_data "$@")
  if [[ -n $jq_expr ]]; then
    echo "$data" | jq -r "$jq_expr"
  else
    echo "$data"
  fi
}
export -f _apply_jq_from_args
