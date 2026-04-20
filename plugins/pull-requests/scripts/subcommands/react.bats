#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/react"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# react subcommand tests
# ============================================================================

@test "cmd_react requires at least 3 arguments" {
  run cmd_react "123" "eyes"

  [[ $status -eq 1 ]]
  [[ $output == *"requires at least 3 arguments"* ]]
}

@test "cmd_react requires --type flag" {
  run cmd_react "123" "eyes" "--unknown" "inline"

  [[ $status -eq 1 ]]
  [[ $output == *"unknown option"* ]]
}

@test "cmd_react rejects invalid type" {
  run cmd_react "123" "eyes" --type "invalid"

  [[ $status -eq 1 ]]
  [[ $output == *"must be 'inline' or 'issue'"* ]]
}

@test "cmd_react rejects unsupported reaction" {
  run cmd_react "123" "invalid_emoji" --type "inline"

  [[ $status -eq 1 ]]
  [[ $output == *"unsupported reaction"* ]]
}

@test "cmd_react calls correct API for inline comments" {
  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return 0
    elif [[ $1 == "api" ]]; then
      echo "API_PATH=$2"
      return 0
    fi
  }
  export -f gh

  run cmd_react "456" "+1" --type "inline"

  [[ $status -eq 0 ]]
  [[ $output == *"repos/owner/repo/pulls/comments/456/reactions"* ]]
}

@test "cmd_react calls correct API for issue comments" {
  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return 0
    elif [[ $1 == "api" ]]; then
      echo "API_PATH=$2"
      return 0
    fi
  }
  export -f gh

  run cmd_react "789" "eyes" --type "issue"

  [[ $status -eq 0 ]]
  [[ $output == *"repos/owner/repo/issues/comments/789/reactions"* ]]
}
