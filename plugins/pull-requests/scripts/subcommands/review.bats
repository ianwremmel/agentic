#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/review.bash"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# review subcommand tests
# ============================================================================

@test "cmd_review requires at least 1 argument" {
  run cmd_review

  [[ $status -eq 1 ]]
  [[ $output == *"requires at least 1 argument"* ]]
}

@test "cmd_review rejects unknown target" {
  run cmd_review bogus

  [[ $status -eq 1 ]]
  [[ $output == *"unknown review target"* ]]
}

# --- review copilot tests ---

@test "has_copilot_review requires exactly 1 argument" {
  run has_copilot_review

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "has_copilot_review returns 0 when copilot is in requested reviewers" {
  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "copilot"
    fi
  }
  export -f gh

  run has_copilot_review "42"

  [[ $status -eq 0 ]]
  [[ $output == *"already requested"* ]]
}

@test "has_copilot_review returns 0 when copilot has submitted a review" {
  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    elif [[ ${5:-} == "reviews" ]]; then
      echo "copilot"
    fi
  }
  export -f gh

  run has_copilot_review "42"

  [[ $status -eq 0 ]]
  [[ $output == *"already reviewed"* ]]
}

@test "has_copilot_review returns 1 when no copilot review exists" {
  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    elif [[ ${5:-} == "reviews" ]]; then
      echo "other-user"
    fi
  }
  export -f gh

  run has_copilot_review "42"

  [[ $status -eq 1 ]]
}

@test "has_copilot_review returns 1 when no reviewers exist" {
  gh() {
    echo ""
  }
  export -f gh

  run has_copilot_review "42"

  [[ $status -eq 1 ]]
}

@test "has_copilot_review does not match partial usernames" {
  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "copilot-bot"
    elif [[ ${5:-} == "reviews" ]]; then
      echo "not-copilot"
    fi
  }
  export -f gh

  run has_copilot_review "42"

  [[ $status -eq 1 ]]
}

@test "request_copilot_review requires exactly 1 argument" {
  run request_copilot_review

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "request_copilot_review calls gh pr edit with --add-reviewer" {
  gh() {
    echo "gh-args: $*"
  }
  export -f gh

  run request_copilot_review "42"

  [[ $status -eq 0 ]]
  [[ $output == *"pr edit 42 --add-reviewer @copilot"* ]]
}

@test "cmd_review_copilot requires exactly 1 argument" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  run cmd_review_copilot

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_review_copilot rejects too many arguments" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  run cmd_review_copilot "42" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_review_copilot uses existing credentials when authenticated as a human" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  is_human_auth() { return 0; }
  export -f is_human_auth

  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "copilot"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Authenticated as a human user"* ]]
}

@test "cmd_review_copilot does not set GH_TOKEN when authenticated as a human" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  is_human_auth() { return 0; }
  export -f is_human_auth

  gh() {
    if [[ $2 == "edit" ]]; then
      echo "GH_TOKEN=${GH_TOKEN:-unset}"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    elif [[ ${5:-} == "reviews" ]]; then
      echo "other-user"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"GH_TOKEN=unset"* ]]
}

@test "cmd_review_copilot requires GH_REVIEW_REQUEST_TOKEN when not authenticated as a human" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  is_human_auth() { return 1; }
  export -f is_human_auth

  gh() {
    # get_gh_user is called only to include the login in the error message.
    if [[ $2 == "user" ]]; then
      echo "some-bot"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 1 ]]
  [[ $output == *"GH_REVIEW_REQUEST_TOKEN must be set"* ]]
  [[ $output == *"current user: some-bot"* ]]
}

@test "cmd_review_copilot reports <unauthenticated> when gh auth fails and no token" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  is_human_auth() { return 1; }
  export -f is_human_auth

  gh() {
    if [[ $2 == "user" ]]; then
      return 1
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 1 ]]
  [[ $output == *"GH_REVIEW_REQUEST_TOKEN must be set"* ]]
  [[ $output == *"current user: <unauthenticated>"* ]]
}

@test "cmd_review_copilot exports GH_TOKEN from GH_REVIEW_REQUEST_TOKEN when not authenticated as a human" {
  unset GH_TOKEN
  export GH_REVIEW_REQUEST_TOKEN="test-token-123"

  is_human_auth() { return 1; }
  export -f is_human_auth

  gh() {
    if [[ $2 == "edit" ]]; then
      echo "GH_TOKEN=${GH_TOKEN:-unset}"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    elif [[ ${5:-} == "reviews" ]]; then
      echo "other-user"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"GH_TOKEN=test-token-123"* ]]
}

@test "cmd_review_copilot does not leak GH_TOKEN into the calling shell" {
  unset GH_TOKEN
  export GH_REVIEW_REQUEST_TOKEN="test-token-abc"

  is_human_auth() { return 1; }
  export -f is_human_auth

  gh() {
    if [[ $2 == "edit" ]]; then
      :  # succeed silently
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    elif [[ ${5:-} == "reviews" ]]; then
      echo "other-user"
    fi
  }
  export -f gh

  # Call directly (not through `run`) so post-call env changes are
  # visible in the bats test shell.
  cmd_review_copilot "42"

  # GH_TOKEN must still be unset in the caller's shell.
  [[ -z ${GH_TOKEN:-} ]]
}

@test "cmd_review_copilot requests review when not a human but token is set" {
  unset GH_TOKEN
  export GH_REVIEW_REQUEST_TOKEN="test-token-123"

  is_human_auth() { return 1; }
  export -f is_human_auth

  gh() {
    if [[ $2 == "edit" ]]; then
      echo "review-requested"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    elif [[ ${5:-} == "reviews" ]]; then
      echo "other-user"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Requesting Copilot review for PR #42"* ]]
  [[ $output == *"Copilot review requested successfully"* ]]
}

@test "cmd_review_copilot skips when copilot review already exists" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  is_human_auth() { return 0; }
  export -f is_human_auth

  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "copilot"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"already requested"* ]]
}

@test "cmd_review_copilot requests review when copilot has not reviewed" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  is_human_auth() { return 0; }
  export -f is_human_auth

  gh() {
    if [[ $2 == "edit" ]]; then
      echo "review-requested"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    elif [[ ${5:-} == "reviews" ]]; then
      echo "other-user"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Requesting Copilot review for PR #42"* ]]
  [[ $output == *"Copilot review requested successfully"* ]]
}

@test "cmd_review_copilot with --force skips copilot review check" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  is_human_auth() { return 0; }
  export -f is_human_auth

  gh() {
    if [[ $2 == "edit" ]]; then
      echo "review-requested"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      # Would normally short-circuit; --force should ignore this.
      echo "copilot"
    fi
  }
  export -f gh

  run cmd_review_copilot --force "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Requesting Copilot review for PR #42"* ]]
  [[ $output == *"Copilot review requested successfully"* ]]
}

@test "cmd_review_copilot without --force still skips when copilot already reviewed" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  is_human_auth() { return 0; }
  export -f is_human_auth

  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    elif [[ ${5:-} == "reviews" ]]; then
      echo "copilot"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"already reviewed"* ]]
}

@test "cmd_review_copilot rejects --force without pr_number" {
  run cmd_review_copilot --force

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_review_copilot rejects too many arguments with --force" {
  run cmd_review_copilot --force "42" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

# --- human reviewer helpers ---

@test "has_human_review_request requires exactly 2 arguments" {
  run has_human_review_request
  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]

  run has_human_review_request "only-one"
  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]
}

@test "has_human_review_request returns 0 when the reviewer is in requested reviewers" {
  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "alice"
    fi
  }
  export -f gh

  run has_human_review_request "alice" "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Review from alice already requested"* ]]
}

@test "has_human_review_request returns 1 when the reviewer has only submitted a review (no pending request)" {
  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "someone-else"
    fi
  }
  export -f gh

  run has_human_review_request "alice" "42"

  [[ $status -eq 1 ]]
}

@test "has_human_review_request returns 1 when no reviewers exist" {
  gh() {
    echo ""
  }
  export -f gh

  run has_human_review_request "alice" "42"

  [[ $status -eq 1 ]]
}

@test "has_human_review_request does not match partial usernames in reviewRequests" {
  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "alice-bot"
    fi
  }
  export -f gh

  run has_human_review_request "alice" "42"

  [[ $status -eq 1 ]]
}

@test "request_human_review requires exactly 2 arguments" {
  run request_human_review
  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]

  run request_human_review "only-one"
  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]
}

@test "request_human_review calls gh pr edit with --add-reviewer" {
  gh() {
    echo "gh-args: $*"
  }
  export -f gh

  run request_human_review "alice" "42"

  [[ $status -eq 0 ]]
  [[ $output == *"pr edit 42 --add-reviewer alice"* ]]
}

# --- cmd_review_human ---

@test "cmd_review_human requires exactly 2 arguments" {
  run cmd_review_human
  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]

  run cmd_review_human "alice"
  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]
}

@test "cmd_review_human rejects too many arguments" {
  run cmd_review_human "alice" "42" "extra"
  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]
}

@test "cmd_review_human skips when authenticated as the reviewer" {
  gh() {
    if [[ $2 == "user" ]]; then
      echo "alice"
    fi
  }
  export -f gh

  run cmd_review_human "alice" "42"

  [[ $status -eq 0 ]]
  [[ $output == *"cannot review own PR, skipping"* ]]
}

@test "cmd_review_human fails when not authenticated" {
  gh() {
    if [[ $2 == "user" ]]; then
      return 1
    fi
  }
  export -f gh

  run cmd_review_human "alice" "42"

  [[ $status -eq 1 ]]
  [[ $output == *"not authenticated with gh"* ]]
}

@test "cmd_review_human skips when reviewer is already requested" {
  gh() {
    if [[ $2 == "user" ]]; then
      echo "ci-bot"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "alice"
    fi
  }
  export -f gh

  run cmd_review_human "alice" "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Review from alice already requested"* ]]
}

@test "cmd_review_human requests review when no existing request" {
  gh() {
    if [[ $2 == "user" ]]; then
      echo "ci-bot"
    elif [[ $2 == "edit" ]]; then
      echo "review-requested"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    fi
  }
  export -f gh

  run cmd_review_human "alice" "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Requesting review from alice for PR #42"* ]]
  [[ $output == *"Review from alice requested successfully"* ]]
}

@test "cmd_review_human re-requests review after reviewer previously reviewed" {
  # reviewRequests is empty but the reviewer has submitted an earlier
  # review; we should treat that as "no pending request" and re-request.
  gh() {
    if [[ $2 == "user" ]]; then
      echo "ci-bot"
    elif [[ $2 == "edit" ]]; then
      echo "review-requested"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    fi
  }
  export -f gh

  run cmd_review_human "alice" "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Requesting review from alice for PR #42"* ]]
}
