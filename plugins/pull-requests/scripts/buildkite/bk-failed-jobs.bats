#!/usr/bin/env bats

setup() {
  source "./scripts/buildkite/bk-failed-jobs"
  source "./scripts/test-helpers.bash"
}

# --- Script structure tests ---

@test "bk-failed-jobs script exists and is executable" {
  [[ -x "./scripts/buildkite/bk-failed-jobs" ]]
}

@test "bk-failed-jobs uses set -euo pipefail" {
  run grep -q 'set -euo pipefail' ./scripts/buildkite/bk-failed-jobs

  [[ $status -eq 0 ]]
}

# --- get_failed_jobs tests ---

@test "get_failed_jobs requires exactly 3 arguments" {
  run get_failed_jobs

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 3 arguments"* ]]
}

@test "get_failed_jobs rejects too few arguments" {
  run get_failed_jobs "org" "pipeline"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 3 arguments"* ]]
}

@test "get_failed_jobs rejects extra arguments" {
  run get_failed_jobs "org" "pipeline" "123" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 3 arguments"* ]]
}

@test "get_failed_jobs passes org/pipeline to bk CLI" {
  # Capture bk's args via a file since the jq pipeline swallows stdout.
  local args_file="$BATS_TEST_TMPDIR/bk-args"
  bk() {
    echo "$*" > "$args_file"
    echo '{"jobs":[]}'
  }
  export -f bk
  export args_file

  run get_failed_jobs "myorg" "mypipe" "123"

  [[ $status -eq 0 ]]
  [[ $(cat "$args_file") == *"-p myorg/mypipe"* ]]
  [[ $(cat "$args_file") == *"build view 123"* ]]
}

@test "get_failed_jobs filters failed and broken jobs" {
  bk() {
    echo '{"jobs":[{"name":"test","state":"failed","id":"abc","retried":false},{"name":"lint","state":"passed","id":"def","retried":false},{"name":"deploy","state":"broken","id":"ghi","retried":false}]}'
  }
  export -f bk

  run get_failed_jobs "org" "pipe" "123"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e 'length == 2'
  echo "$output" | jq -e '.[0].name == "test"'
  echo "$output" | jq -e '.[0].state == "failed"'
  echo "$output" | jq -e '.[1].name == "deploy"'
  echo "$output" | jq -e '.[1].state == "broken"'
}

@test "get_failed_jobs returns empty array when no failures" {
  bk() {
    echo '{"jobs":[{"name":"test","state":"passed","id":"abc","retried":false}]}'
  }
  export -f bk

  run get_failed_jobs "org" "pipe" "123"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e 'length == 0'
}

# --- main tests ---

@test "main requires exactly 3 arguments" {
  run main

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 3 arguments"* ]]
}

@test "main rejects extra arguments" {
  run main "org" "pipe" "123" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 3 arguments"* ]]
}

@test "main outputs JSON array" {
  bk() {
    echo '{"jobs":[{"name":"test","state":"failed","id":"abc","retried":false}]}'
  }
  export -f bk

  run main "org" "pipe" "123"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e 'type == "array"'
}
