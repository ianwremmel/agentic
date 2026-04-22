#!/usr/bin/env bats

setup() {
  source "./scripts/orchestrate"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# Script structure tests
# ============================================================================


@test "orchestrate script exists and is executable" {
  [[ -x "./scripts/orchestrate" ]]
}

@test "orchestrate uses set -euo pipefail" {
  run grep -q 'set -euo pipefail' ./scripts/orchestrate

  [[ $status -eq 0 ]]
}

# ============================================================================
# Top-level dispatch tests
# ============================================================================


@test "main requires a subcommand" {
  run main

  [[ $status -eq 1 ]]
  [[ $output == *"subcommand required"* ]]
}

@test "main rejects unknown subcommand" {
  run main foobar

  [[ $status -eq 1 ]]
  [[ $output == *"unknown subcommand"* ]]
}

@test "main dispatches to check-status" {
  cmd_check_status() {
    echo "check-status called with: $*"
  }
  export -f cmd_check_status

  run main check-status "42"

  [[ $status -eq 0 ]]
  [[ $output == *"check-status called with: 42"* ]]
}
