#!/usr/bin/env bats

setup() {
  source "./scripts/buildkite/bk-job-log"

  # Mock retry after sourcing so it overrides the real _retry implementation
  retry() {
    shift 2
    "$@"
  }
  export -f retry
}

# --- Script structure tests ---

@test "bk-job-log script exists and is executable" {
  [[ -x "./scripts/buildkite/bk-job-log" ]]
}

@test "bk-job-log uses set -euo pipefail" {
  run grep -q 'set -euo pipefail' ./scripts/buildkite/bk-job-log

  [[ $status -eq 0 ]]
}

# --- get_job_log tests ---

@test "get_job_log requires at least 2 arguments" {
  run get_job_log

  [[ $status -eq 2 ]]
  [[ $output == *"requires 2-3 arguments"* ]]
}

@test "get_job_log rejects single argument" {
  run get_job_log "123"

  [[ $status -eq 2 ]]
  [[ $output == *"requires 2-3 arguments"* ]]
}

@test "get_job_log rejects more than 3 arguments" {
  run get_job_log "123" "abc" "200" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires 2-3 arguments"* ]]
}

@test "get_job_log defaults to 200 lines" {
  # Generate 300 lines of output
  bk() {
    for i in $(seq 1 300); do
      echo "line $i"
    done
  }
  export -f bk

  run get_job_log "123" "abc"

  [[ $status -eq 0 ]]
  local line_count
  line_count=$(echo "$output" | wc -l | tr -d ' ')
  [[ $line_count -eq 200 ]]
}

@test "get_job_log respects custom tail_lines" {
  bk() {
    for i in $(seq 1 100); do
      echo "line $i"
    done
  }
  export -f bk

  run get_job_log "123" "abc" "50"

  [[ $status -eq 0 ]]
  local line_count
  line_count=$(echo "$output" | wc -l | tr -d ' ')
  [[ $line_count -eq 50 ]]
}

# --- main tests ---

@test "main requires at least 2 positional arguments" {
  run main

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 2 positional arguments"* ]]
}

@test "main rejects single argument" {
  run main "123"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 2 positional arguments"* ]]
}

@test "main rejects extra positional arguments" {
  run main "123" "abc" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 2 positional arguments"* ]]
}

@test "main parses --tail flag" {
  bk() {
    for i in $(seq 1 100); do
      echo "line $i"
    done
  }
  export -f bk

  run main "123" "abc" --tail 10

  [[ $status -eq 0 ]]
  local line_count
  line_count=$(echo "$output" | wc -l | tr -d ' ')
  [[ $line_count -eq 10 ]]
}

@test "main parses --tail flag before positional args" {
  bk() {
    for i in $(seq 1 100); do
      echo "line $i"
    done
  }
  export -f bk

  run main --tail 10 "123" "abc"

  [[ $status -eq 0 ]]
  local line_count
  line_count=$(echo "$output" | wc -l | tr -d ' ')
  [[ $line_count -eq 10 ]]
}

@test "main rejects --tail without value" {
  run main "123" "abc" --tail

  [[ $status -eq 1 ]]
  [[ $output == *"--tail requires a value"* ]]
}
