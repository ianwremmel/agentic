#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/reply.bash"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# reply subcommand tests
# ============================================================================

@test "reply_inline wraps body in sparkles when human-authenticated" {
  gh() {
    if [[ $1 == "api" && $2 == "user" ]]; then
      echo "User|alice"
      return
    fi
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return
    fi
    # Capture the body field value
    for arg in "$@"; do
      if [[ $arg == body=* ]]; then
        echo "$arg"
      fi
    done
  }
  export -f gh

  run reply_inline "42" "100" "my reply text"

  [[ $status -eq 0 ]]
  [[ $output == *"<!-- agent-reply -->"* ]]
  [[ $output == *"my reply text"* ]]
  printf '%s' "$output" | grep -q $'\xe2\x9c\xa8'
}

@test "reply_issue wraps body in sparkles when human-authenticated" {
  gh() {
    if [[ $1 == "api" && $2 == "user" ]]; then
      echo "User|alice"
      return
    fi
    echo "gh-args: $*"
  }
  export -f gh

  run reply_issue "42" "my comment"

  [[ $status -eq 0 ]]
  [[ $output == *"<!-- agent-reply -->"* ]]
  [[ $output == *"my comment"* ]]
  printf '%s' "$output" | grep -q $'\xe2\x9c\xa8'
}

@test "reply_issue omits sparkles when authenticated as a bot" {
  gh() {
    if [[ $1 == "api" && $2 == "user" ]]; then
      echo "Bot|copilot"
      return
    fi
    echo "gh-args: $*"
  }
  export -f gh

  run reply_issue "42" "my comment"

  [[ $status -eq 0 ]]
  [[ $output == *"<!-- agent-reply -->"* ]]
  [[ $output == *"my comment"* ]]
  ! printf '%s' "$output" | grep -q $'\xe2\x9c\xa8'
}

@test "reply_inline requires exactly 3 arguments" {
  run reply_inline

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 3 arguments"* ]]
}

@test "reply_inline rejects too many arguments" {
  run reply_inline "42" "100" "body" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 3 arguments"* ]]
}

@test "reply_inline prefixes body with agent-reply marker" {
  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return
    fi
    # Capture the body field value
    for arg in "$@"; do
      if [[ $arg == body=* ]]; then
        echo "$arg"
      fi
    done
  }
  export -f gh

  run reply_inline "42" "100" "my reply text"

  [[ $status -eq 0 ]]
  [[ $output == *"body=<!-- agent-reply -->"* ]]
  [[ $output == *"my reply text"* ]]
}

@test "reply_inline calls correct API endpoint" {
  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return
    fi
    echo "gh-args: $*"
  }
  export -f gh

  run reply_inline "42" "100" "my reply"

  [[ $status -eq 0 ]]
  [[ $output == *"repos/owner/repo/pulls/42/comments/100/replies"* ]]
}

@test "reply_issue requires exactly 2 arguments" {
  run reply_issue

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]
}

@test "reply_issue rejects too many arguments" {
  run reply_issue "42" "body" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]
}

@test "reply_issue prefixes body with agent-reply marker" {
  gh() {
    echo "gh-args: $*"
  }
  export -f gh

  run reply_issue "42" "my comment"

  [[ $status -eq 0 ]]
  [[ $output == *"<!-- agent-reply -->"* ]]
  [[ $output == *"my comment"* ]]
}

@test "cmd_reply rejects missing mode" {
  run cmd_reply

  [[ $status -eq 1 ]]
  [[ $output == *"requires at least 1 argument"* ]]
}

@test "cmd_reply rejects unknown mode" {
  run cmd_reply --unknown

  [[ $status -eq 1 ]]
  [[ $output == *"unknown mode"* ]]
}

@test "cmd_reply --inline requires 3 arguments" {
  run cmd_reply --inline "42"

  [[ $status -eq 1 ]]
  [[ $output == *"--inline requires 3 arguments"* ]]
}

@test "cmd_reply --issue requires 2 arguments" {
  run cmd_reply --issue

  [[ $status -eq 1 ]]
  [[ $output == *"--issue requires 2 arguments"* ]]
}
