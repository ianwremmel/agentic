#!/usr/bin/env bats

setup() {
  source "./scripts/lib/gh-auth.bash"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# --- is_human_auth tests ---

@test "is_human_auth returns 0 for User-type human login" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "User|alice"
  }
  export -f gh

  run is_human_auth

  [[ $status -eq 0 ]]
}

@test "is_human_auth returns 1 for Bot-type account" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "Bot|copilot"
  }
  export -f gh

  run is_human_auth

  [[ $status -eq 1 ]]
}

@test "is_human_auth returns 1 for User-type login matching agent pattern (claude)" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "User|claude-bot"
  }
  export -f gh

  run is_human_auth

  [[ $status -eq 1 ]]
}

@test "is_human_auth returns 1 for User-type login matching agent pattern (copilot)" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "User|gh-copilot-svc"
  }
  export -f gh

  run is_human_auth

  [[ $status -eq 1 ]]
}

@test "is_human_auth returns 1 for User-type login matching agent pattern (codex)" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "User|codex-runner"
  }
  export -f gh

  run is_human_auth

  [[ $status -eq 1 ]]
}

@test "is_human_auth returns 1 for User-type login matching agent pattern (ai-agent, case-insensitive)" {
  # The login is lowercased before pattern matching, so SOME-AI-AGENT-X matches *ai-agent*.
  # Simulate that by returning the already-lowercased form (matches what --jq | ascii_downcase would produce).
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "User|some-ai-agent-x"
  }
  export -f gh

  run is_human_auth

  [[ $status -eq 1 ]]
}

@test "is_human_auth returns 1 when gh fails (unauthenticated)" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && return 1
  }
  export -f gh

  run is_human_auth

  [[ $status -eq 1 ]]
}

@test "is_human_auth returns 1 on malformed gh output" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "garbage-no-pipe"
  }
  export -f gh

  run is_human_auth

  [[ $status -eq 1 ]]
}

# --- wrap_agent_body tests ---

@test "wrap_agent_body always includes the HTML marker (human)" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "User|alice"
  }
  export -f gh

  run wrap_agent_body "hello"

  [[ $status -eq 0 ]]
  [[ $output == *"<!-- agent-reply -->"* ]]
}

@test "wrap_agent_body always includes the HTML marker (bot)" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "Bot|copilot"
  }
  export -f gh

  run wrap_agent_body "hello"

  [[ $status -eq 0 ]]
  [[ $output == *"<!-- agent-reply -->"* ]]
}

@test "wrap_agent_body wraps body in sparkles when human-authenticated" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "User|alice"
  }
  export -f gh

  run wrap_agent_body "my comment body"

  [[ $status -eq 0 ]]
  # Two sparkles, one before and one after the body
  local sparkle_count
  sparkle_count=$(printf '%s' "$output" | grep -c $'\xe2\x9c\xa8' || true)
  [[ $sparkle_count -eq 2 ]]
  [[ $output == *"my comment body"* ]]
}

@test "wrap_agent_body omits sparkles when authenticated as a bot" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "Bot|copilot"
  }
  export -f gh

  run wrap_agent_body "my comment body"

  [[ $status -eq 0 ]]
  ! printf '%s' "$output" | grep -q $'\xe2\x9c\xa8'
  [[ $output == *"my comment body"* ]]
}

@test "wrap_agent_body omits sparkles when login matches agent pattern" {
  gh() {
    [[ $1 == "api" && $2 == "user" ]] && echo "User|claude-bot"
  }
  export -f gh

  run wrap_agent_body "my comment body"

  [[ $status -eq 0 ]]
  ! printf '%s' "$output" | grep -q $'\xe2\x9c\xa8'
}
# ============================================================================
# Shared helper tests
# ============================================================================

@test "get_gh_user takes no arguments" {
  run get_gh_user "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"takes no arguments"* ]]
}

@test "get_gh_user returns login from gh api" {
  gh() {
    echo "someuser"
  }
  export -f gh

  run get_gh_user

  [[ $status -eq 0 ]]
  [[ $output == "someuser" ]]
}
