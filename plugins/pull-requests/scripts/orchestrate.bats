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


# ============================================================================
# dispatch tests for new subcommands
# ============================================================================

@test "main dispatches to setup" {
  cmd_setup() {
    echo "setup called with: $*"
  }
  export -f cmd_setup

  run main setup "/tmp/test"

  [[ $status -eq 0 ]]
  [[ $output == *"setup called with: /tmp/test"* ]]
}

@test "main dispatches to find-worktree" {
  cmd_find_worktree() {
    echo "find-worktree called with: $*"
  }
  export -f cmd_find_worktree

  run main find-worktree "CLC-100"

  [[ $status -eq 0 ]]
  [[ $output == *"find-worktree called with: CLC-100"* ]]
}

@test "main dispatches to react" {
  cmd_react() {
    echo "react called with: $*"
  }
  export -f cmd_react

  run main react "123" "eyes" --type "inline"

  [[ $status -eq 0 ]]
  [[ $output == *"react called with: 123 eyes --type inline"* ]]
}

@test "main dispatches to label" {
  cmd_label() {
    echo "label called with: $*"
  }
  export -f cmd_label

  run main label add "42" "agent-working"

  [[ $status -eq 0 ]]
  [[ $output == *"label called with: add 42 agent-working"* ]]
}

@test "main dispatches to start-pr" {
  cmd_start_pr() {
    echo "start-pr called with: $*"
  }
  export -f cmd_start_pr

  run main start-pr "/tmp/test" --ticket-id "CLC-100"

  [[ $status -eq 0 ]]
  [[ $output == *"start-pr called with: /tmp/test --ticket-id CLC-100"* ]]
}

@test "main dispatches to poll" {
  cmd_poll() {
    echo "poll called with: $*"
  }
  export -f cmd_poll

  run main poll "42" "abc123"

  [[ $status -eq 0 ]]
  [[ $output == *"poll called with: 42 abc123"* ]]
}

@test "main dispatches to review" {
  cmd_review() {
    echo "review called with: $*"
  }
  export -f cmd_review

  run main review copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"review called with: copilot 42"* ]]
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


@test "main dispatches to debug" {
  cmd_debug() {
    echo "debug called with: $*"
  }
  export -f cmd_debug

  run main debug "42"

  [[ $status -eq 0 ]]
  [[ $output == *"debug called with: 42"* ]]
}
