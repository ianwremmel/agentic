#!/usr/bin/env bats

setup() {
  source "./scripts/buildkite/bk-failure-info"

  # Mock retry after sourcing so it overrides the real _retry implementation
  retry() {
    shift 2
    "$@"
  }
  export -f retry
}

# --- Script structure tests ---

@test "bk-failure-info script exists and is executable" {
  [[ -x "./scripts/buildkite/bk-failure-info" ]]
}

@test "bk-failure-info uses set -euo pipefail" {
  run grep -q 'set -euo pipefail' ./scripts/buildkite/bk-failure-info

  [[ $status -eq 0 ]]
}

# --- get_annotations tests ---

@test "get_annotations requires exactly 1 argument" {
  run get_annotations

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "get_annotations rejects extra arguments" {
  run get_annotations "123" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "get_annotations returns annotation data" {
  bk() {
    echo '[{"style":"error","body_html":"<p>Failed</p>","extra":"ignored"},{"style":"warning","body_html":"<p>Slow</p>","extra":"ignored"}]'
  }
  export -f bk

  run get_annotations "123"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e 'length == 2'
  echo "$output" | jq -e '.[0].style == "error"'
  echo "$output" | jq -e '.[0].body_html == "<p>Failed</p>"'
  echo "$output" | jq -e '.[0] | has("extra") | not'
}

# --- get_junit_artifacts tests ---

@test "get_junit_artifacts requires exactly 1 argument" {
  run get_junit_artifacts

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "get_junit_artifacts rejects extra arguments" {
  run get_junit_artifacts "123" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "get_junit_artifacts filters XML files" {
  bk() {
    echo '[{"id":"a1","filename":"results.xml","extra":"ignored"},{"id":"a2","filename":"coverage.json","extra":"ignored"},{"id":"a3","filename":"junit-report.xml","extra":"ignored"}]'
  }
  export -f bk

  run get_junit_artifacts "123"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e 'length == 2'
  echo "$output" | jq -e '.[0].filename == "results.xml"'
  echo "$output" | jq -e '.[1].filename == "junit-report.xml"'
  echo "$output" | jq -e '.[0] | has("extra") | not'
}

# --- main tests ---

@test "main requires exactly 1 argument" {
  run main

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "main rejects extra arguments" {
  run main "123" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "main combines annotations and artifacts" {
  bk() {
    if [[ $1 == "api" ]]; then
      echo '[{"style":"error","body_html":"<p>Failed</p>"}]'
    elif [[ $1 == "artifacts" ]]; then
      echo '[{"id":"a1","filename":"results.xml"}]'
    fi
  }
  export -f bk

  run main "123"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.annotations | length == 1'
  echo "$output" | jq -e '.junit_artifacts | length == 1'
  echo "$output" | jq -e '.annotations[0].style == "error"'
  echo "$output" | jq -e '.junit_artifacts[0].filename == "results.xml"'
}
