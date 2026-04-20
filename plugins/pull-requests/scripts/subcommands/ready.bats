#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/ready.bash"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# ready subcommand tests
# ============================================================================

@test "mark_ready requires exactly 1 argument" {
  run mark_ready

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "mark_ready rejects too many arguments" {
  run mark_ready "42" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "mark_ready calls gh pr ready" {
  gh() {
    echo "gh-args: $*"
  }
  export -f gh

  run mark_ready "42"

  [[ $status -eq 0 ]]
  [[ $output == *"pr ready 42"* ]]
}

@test "cmd_ready requires exactly 1 argument" {
  run cmd_ready

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_ready rejects too many arguments" {
  run cmd_ready "42" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_ready outputs success message" {
  gh() {
    echo "gh-args: $*"
  }
  export -f gh

  run cmd_ready "42"

  [[ $status -eq 0 ]]
  [[ $output == *"PR #42 marked as ready for review"* ]]
}
