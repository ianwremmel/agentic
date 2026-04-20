#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/review"
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

@test "cmd_review_copilot uses existing credentials when user is ianwremmel" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  gh() {
    if [[ $2 == "user" ]]; then
      echo "ianwremmel"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "copilot"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Authenticated as ianwremmel"* ]]
}

@test "cmd_review_copilot does not set GH_TOKEN when user is ianwremmel" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  gh() {
    if [[ $2 == "user" ]]; then
      echo "ianwremmel"
    elif [[ $2 == "edit" ]]; then
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

@test "cmd_review_copilot requires GH_REVIEW_REQUEST_TOKEN when user is not ianwremmel" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  gh() {
    if [[ $2 == "user" ]]; then
      echo "other-user"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 1 ]]
  [[ $output == *"GH_REVIEW_REQUEST_TOKEN must be set"* ]]
  [[ $output == *"current user: other-user"* ]]
}

@test "cmd_review_copilot exports GH_TOKEN from GH_REVIEW_REQUEST_TOKEN when user is not ianwremmel" {
  unset GH_TOKEN
  export GH_REVIEW_REQUEST_TOKEN="test-token-123"

  gh() {
    if [[ $2 == "user" ]]; then
      echo "ci-bot"
    elif [[ $2 == "edit" ]]; then
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

@test "cmd_review_copilot requests review when gh auth fails but GH_REVIEW_REQUEST_TOKEN is set" {
  unset GH_TOKEN
  export GH_REVIEW_REQUEST_TOKEN="test-token-123"

  gh() {
    if [[ $2 == "user" ]]; then
      return 1
    elif [[ $2 == "edit" ]]; then
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

@test "cmd_review_copilot fails when gh auth fails and GH_REVIEW_REQUEST_TOKEN is not set" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  gh() {
    if [[ $2 == "user" ]]; then
      return 1
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 1 ]]
  [[ $output == *"not authenticated with gh and GH_REVIEW_REQUEST_TOKEN is not set"* ]]
}

@test "cmd_review_copilot skips when copilot review already exists" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  gh() {
    if [[ $2 == "user" ]]; then
      echo "ianwremmel"
    elif [[ ${5:-} == "reviewRequests" ]]; then
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

  gh() {
    if [[ $2 == "user" ]]; then
      echo "ianwremmel"
    elif [[ $2 == "edit" ]]; then
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

  gh() {
    if [[ $2 == "user" ]]; then
      echo "ianwremmel"
    elif [[ $2 == "edit" ]]; then
      echo "review-requested"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "copilot"
    elif [[ ${5:-} == "reviews" ]]; then
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

  gh() {
    if [[ $2 == "user" ]]; then
      echo "ianwremmel"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "copilot"
    fi
  }
  export -f gh

  run cmd_review_copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"already requested"* ]]
}

@test "cmd_review_copilot rejects --force without pr_number" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  run cmd_review_copilot --force

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_review_copilot rejects too many arguments with --force" {
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN

  run cmd_review_copilot --force "42" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

# --- review human tests ---

@test "has_human_review requires exactly 1 argument" {
  run has_human_review

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "has_human_review returns 0 when ianwremmel is in requested reviewers" {
  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "ianwremmel"
    fi
  }
  export -f gh

  run has_human_review "42"

  [[ $status -eq 0 ]]
  [[ $output == *"already requested"* ]]
}

@test "has_human_review returns 1 when ianwremmel has submitted a review but no pending request" {
  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "other-user"
    fi
  }
  export -f gh

  run has_human_review "42"

  [[ $status -eq 1 ]]
}

@test "has_human_review returns 1 when no reviewers exist" {
  gh() {
    echo ""
  }
  export -f gh

  run has_human_review "42"

  [[ $status -eq 1 ]]
}

@test "has_human_review does not match partial usernames in reviewRequests" {
  gh() {
    if [[ ${5:-} == "reviewRequests" ]]; then
      echo "ianwremmel-bot"
    fi
  }
  export -f gh

  run has_human_review "42"

  [[ $status -eq 1 ]]
}

@test "request_human_review requires exactly 1 argument" {
  run request_human_review

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "request_human_review calls gh pr edit with --add-reviewer" {
  gh() {
    echo "gh-args: $*"
  }
  export -f gh

  run request_human_review "42"

  [[ $status -eq 0 ]]
  [[ $output == *"pr edit 42 --add-reviewer ianwremmel"* ]]
}

@test "cmd_review_human requires exactly 1 argument" {
  run cmd_review_human

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_review_human rejects too many arguments" {
  run cmd_review_human "42" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_review_human skips when authenticated as ianwremmel" {
  gh() {
    if [[ $2 == "user" ]]; then
      echo "ianwremmel"
    fi
  }
  export -f gh

  run cmd_review_human "42"

  [[ $status -eq 0 ]]
  [[ $output == *"cannot review own PR"* ]]
}

@test "cmd_review_human fails when not authenticated" {
  gh() {
    if [[ $2 == "user" ]]; then
      return 1
    fi
  }
  export -f gh

  run cmd_review_human "42"

  [[ $status -eq 1 ]]
  [[ $output == *"not authenticated with gh"* ]]
}

@test "cmd_review_human skips when ianwremmel review already exists" {
  gh() {
    if [[ $2 == "user" ]]; then
      echo "ci-bot"
    elif [[ ${5:-} == "reviewRequests" ]]; then
      echo "ianwremmel"
    fi
  }
  export -f gh

  run cmd_review_human "42"

  [[ $status -eq 0 ]]
  [[ $output == *"already requested"* ]]
}

@test "cmd_review_human requests review when no existing review" {
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

  run cmd_review_human "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Requesting human review for PR #42"* ]]
  [[ $output == *"Human review requested successfully"* ]]
}

@test "cmd_review_human re-requests review after ianwremmel previously reviewed" {
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

  run cmd_review_human "42"

  [[ $status -eq 0 ]]
  [[ $output == *"Requesting human review for PR #42"* ]]
}
