#!/usr/bin/env bats

setup() {
  source "./scripts/buildkite/bk-job-log"
  source "./scripts/test-helpers.bash"

  # Isolate the cache directory per-test so downloads and cache hits are
  # observable.
  export BK_JOB_LOG_CACHE_DIR="$(mktemp -d)"
  BK_JOB_LOG_CACHE_DIR="$BK_JOB_LOG_CACHE_DIR"
}

teardown() {
  [[ -n ${BK_JOB_LOG_CACHE_DIR:-} && -d $BK_JOB_LOG_CACHE_DIR ]] && rm -rf "$BK_JOB_LOG_CACHE_DIR"
}

# --- Script structure ---

@test "bk-job-log script exists and is executable" {
  [[ -x "./scripts/buildkite/bk-job-log" ]]
}

@test "bk-job-log uses set -euo pipefail" {
  run grep -q 'set -euo pipefail' ./scripts/buildkite/bk-job-log
  [[ $status -eq 0 ]]
}

# --- resolve_range unit tests ---

@test "resolve_range: single positive line" {
  run resolve_range "50" 300
  [[ $status -eq 0 ]]
  [[ $output == "50 50" ]]
}

@test "resolve_range: single negative line (last)" {
  run resolve_range "-1" 300
  [[ $status -eq 0 ]]
  [[ $output == "300 300" ]]
}

@test "resolve_range: positive start through end" {
  run resolve_range "100:" 300
  [[ $status -eq 0 ]]
  [[ $output == "100 300" ]]
}

@test "resolve_range: beginning through positive end" {
  run resolve_range ":50" 300
  [[ $status -eq 0 ]]
  [[ $output == "1 50" ]]
}

@test "resolve_range: negative start to end (last N lines)" {
  run resolve_range "-200:" 300
  [[ $status -eq 0 ]]
  [[ $output == "101 300" ]]
}

@test "resolve_range: negative start, negative end" {
  run resolve_range "-10:-5" 100
  [[ $status -eq 0 ]]
  [[ $output == "91 96" ]]
}

@test "resolve_range: whole log" {
  run resolve_range ":" 300
  [[ $status -eq 0 ]]
  [[ $output == "1 300" ]]
}

@test "resolve_range: clamps out-of-bounds start" {
  run resolve_range "-500:" 100
  [[ $status -eq 0 ]]
  [[ $output == "1 100" ]]
}

@test "resolve_range: clamps out-of-bounds end" {
  run resolve_range "50:9999" 100
  [[ $status -eq 0 ]]
  [[ $output == "50 100" ]]
}

@test "resolve_range: empty log yields empty slice" {
  run resolve_range "-200:" 0
  [[ $status -eq 0 ]]
  [[ $output == "1 0" ]]
}

@test "resolve_range: malformed spec returns error" {
  run resolve_range "abc" 100
  [[ $status -eq 2 ]]
  [[ $output == *"invalid --lines range"* ]]
}

# --- extract_log_range tests ---

@test "extract_log_range: returns last-N-lines for --lines -3:" {
  local f="$BATS_TEST_TMPDIR/sample.log"
  for i in $(seq 1 10); do echo "line $i"; done > "$f"

  run extract_log_range "$f" "-3:"
  [[ $status -eq 0 ]]
  [[ $output == "line 8"$'\n'"line 9"$'\n'"line 10" ]]
}

@test "extract_log_range: returns explicit range" {
  local f="$BATS_TEST_TMPDIR/sample.log"
  for i in $(seq 1 10); do echo "line $i"; done > "$f"

  run extract_log_range "$f" "4:6"
  [[ $status -eq 0 ]]
  [[ $output == "line 4"$'\n'"line 5"$'\n'"line 6" ]]
}

# --- get_job_log caching tests ---

@test "get_job_log: downloads on first call, uses cache on second" {
  local call_count_file="$BATS_TEST_TMPDIR/bk-calls"
  echo 0 > "$call_count_file"
  bk() {
    local n
    n=$(cat "$call_count_file")
    echo $((n + 1)) > "$call_count_file"
    for i in $(seq 1 10); do echo "log-line $i"; done
  }
  export -f bk
  export call_count_file

  run get_job_log "org" "pipe" "123" "jobA" "-2:"
  [[ $status -eq 0 ]]
  [[ $output == "log-line 9"$'\n'"log-line 10" ]]
  [[ $(cat "$call_count_file") == "1" ]]

  run get_job_log "org" "pipe" "123" "jobA" "-2:"
  [[ $status -eq 0 ]]
  # Still the same result, and bk was NOT called again.
  [[ $(cat "$call_count_file") == "1" ]]
}

@test "get_job_log: --refresh forces re-download" {
  local call_count_file="$BATS_TEST_TMPDIR/bk-calls"
  echo 0 > "$call_count_file"
  bk() {
    local n
    n=$(cat "$call_count_file")
    echo $((n + 1)) > "$call_count_file"
    for i in $(seq 1 5); do echo "l$i"; done
  }
  export -f bk
  export call_count_file

  run get_job_log "org" "pipe" "123" "jobA"
  [[ $(cat "$call_count_file") == "1" ]]

  run get_job_log "org" "pipe" "123" "jobA" "" "1"
  [[ $(cat "$call_count_file") == "2" ]]
}

@test "get_job_log: default range returns last 200 lines" {
  bk() {
    for i in $(seq 1 300); do echo "l$i"; done
  }
  export -f bk

  run get_job_log "org" "pipe" "123" "jobA"
  [[ $status -eq 0 ]]
  local line_count
  line_count=$(echo "$output" | wc -l | tr -d ' ')
  [[ $line_count -eq 200 ]]
  [[ $output == *"l101"* ]]
  [[ $output == *"l300"* ]]
  [[ $output != *"l100"$'\n'* ]]
}

@test "get_job_log: requires 4-6 arguments" {
  run get_job_log "org" "pipe" "123"
  [[ $status -eq 2 ]]
  [[ $output == *"requires 4-6 arguments"* ]]

  run get_job_log "a" "b" "c" "d" "e" "f" "g"
  [[ $status -eq 2 ]]
  [[ $output == *"requires 4-6 arguments"* ]]
}

# --- main CLI flag parsing ---

@test "main requires exactly 4 positional arguments" {
  run main "org" "pipe" "123"
  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 4 positional arguments"* ]]

  run main "org" "pipe" "123" "job" "extra"
  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 4 positional arguments"* ]]
}

@test "main accepts --lines flag" {
  bk() { for i in $(seq 1 50); do echo "L$i"; done; }
  export -f bk

  run main "org" "pipe" "123" "jobA" --lines "-5:"
  [[ $status -eq 0 ]]
  local line_count
  line_count=$(echo "$output" | wc -l | tr -d ' ')
  [[ $line_count -eq 5 ]]
  [[ $output == *"L46"* ]]
  [[ $output == *"L50"* ]]
}

@test "main accepts --lines flag before positionals" {
  bk() { for i in $(seq 1 50); do echo "L$i"; done; }
  export -f bk

  run main --lines "1:3" "org" "pipe" "123" "jobA"
  [[ $status -eq 0 ]]
  [[ $output == "L1"$'\n'"L2"$'\n'"L3" ]]
}

@test "main rejects --lines without value" {
  run main "org" "pipe" "123" "jobA" --lines
  [[ $status -eq 1 ]]
  [[ $output == *"--lines requires a value"* ]]
}

@test "main --refresh forces re-download" {
  local call_count_file="$BATS_TEST_TMPDIR/bk-calls"
  echo 0 > "$call_count_file"
  bk() {
    local n
    n=$(cat "$call_count_file")
    echo $((n + 1)) > "$call_count_file"
    echo "some-line"
  }
  export -f bk
  export call_count_file

  run main "org" "pipe" "123" "jobA"
  [[ $(cat "$call_count_file") == "1" ]]

  run main "org" "pipe" "123" "jobA" --refresh
  [[ $(cat "$call_count_file") == "2" ]]
}
