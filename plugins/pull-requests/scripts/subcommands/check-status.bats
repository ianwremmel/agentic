#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/check-status"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# check-status subcommand tests
# ============================================================================

@test "cmd_check_status requires exactly 1 argument" {
  run cmd_check_status

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_check_status rejects too many arguments" {
  run cmd_check_status "42" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "fetch_check_status requires exactly 1 argument" {
  run fetch_check_status

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "fetch_check_status returns merged status for merged PR" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "MERGED",
        "labels": [],
        "reviews": [],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  local result
  result=$(echo "$output" | jq '.')
  [[ $(echo "$result" | jq -r '.merged') == "true" ]]
  [[ $(echo "$result" | jq -r '.closed') == "false" ]]
  [[ $(echo "$result" | jq -r '.ci_state') == "pending" ]]
}

@test "fetch_check_status returns closed status for closed PR" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "CLOSED",
        "labels": [],
        "reviews": [],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.closed') == "true" ]]
  [[ $(echo "$output" | jq -r '.merged') == "false" ]]
}

@test "fetch_check_status detects CI success state" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [{"name": "agent-working"}],
        "reviews": [],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[{"context": "buildkite/test", "state": "success", "updated_at": "2026-03-17T00:00:00Z", "target_url": "https://example.com"}]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.ci_state') == "success" ]]
  [[ $(echo "$output" | jq -r '.labels[0]') == "agent-working" ]]
}

@test "fetch_check_status detects CI failure state" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[{"context": "buildkite/test", "state": "failure", "updated_at": "2026-03-17T00:00:00Z", "target_url": "https://example.com"}]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.ci_state') == "failure" ]]
}

@test "fetch_check_status returns ci_state error when statuses API fails" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      return 1
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.ci_state') == "error" ]]
}

@test "fetch_check_status computes approval_state APPROVED" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [{"state": "APPROVED", "author": {"login": "ianwremmel"}}],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.approval_state') == "APPROVED" ]]
}

@test "fetch_check_status computes approval_state CHANGES_REQUESTED" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [{"state": "CHANGES_REQUESTED", "author": {"login": "ianwremmel"}}],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.approval_state') == "CHANGES_REQUESTED" ]]
  [[ $(echo "$output" | jq -r '.has_feedback') == "true" ]]
}

@test "fetch_check_status approval_state uses last review per author (APPROVED overrides CHANGES_REQUESTED)" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [
          {"state": "CHANGES_REQUESTED", "author": {"login": "ianwremmel"}},
          {"state": "APPROVED", "author": {"login": "ianwremmel"}}
        ],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.approval_state') == "APPROVED" ]]
}

@test "fetch_check_status approval_state uses last review per author (CHANGES_REQUESTED overrides APPROVED)" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [
          {"state": "APPROVED", "author": {"login": "ianwremmel"}},
          {"state": "CHANGES_REQUESTED", "author": {"login": "ianwremmel"}}
        ],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.approval_state') == "CHANGES_REQUESTED" ]]
}

@test "fetch_check_status detects copilot_clean when copilot reviewed and not re-requested" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [{"state": "COMMENTED", "author": {"login": "copilot"}}],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.copilot_clean') == "true" ]]
  [[ $(echo "$output" | jq -r '.needs_copilot_request') == "false" ]]
}

@test "fetch_check_status detects copilot not clean when re-requested" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [{"state": "COMMENTED", "author": {"login": "copilot"}}],
        "reviewRequests": [{"login": "copilot"}],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.copilot_clean') == "false" ]]
  [[ $(echo "$output" | jq -r '.needs_copilot_request') == "false" ]]
}

@test "fetch_check_status detects needs_copilot_request when copilot never reviewed" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.needs_copilot_request') == "true" ]]
  [[ $(echo "$output" | jq -r '.copilot_clean') == "false" ]]
}

@test "fetch_check_status excludes copilot from approval_state computation" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [
          {"state": "COMMENTED", "author": {"login": "copilot"}},
          {"state": "APPROVED", "author": {"login": "ianwremmel"}}
        ],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.approval_state') == "APPROVED" ]]
}

@test "fetch_check_status returns exit 1 on API failure" {
  gh() {
    return 1
  }
  export -f gh

  run fetch_check_status "42"

  [[ $status -eq 1 ]]
  [[ $output == *"failed to fetch"* ]]
}

@test "fetch_check_status handles PR with multiple labels" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [{"name": "agent-working"}, {"name": "needs-followup"}],
        "reviews": [],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.labels | length') == "2" ]]
  [[ $(echo "$output" | jq -r '.labels[0]') == "agent-working" ]]
  [[ $(echo "$output" | jq -r '.labels[1]') == "needs-followup" ]]
}

@test "fetch_check_status detects unresolved human inline comments as has_feedback" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[
        {"id": 100, "user": {"login": "ianwremmel", "type": "User"}, "body": "Please fix this variable name", "in_reply_to_id": null}
      ]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.has_feedback') == "true" ]]
}

@test "fetch_check_status marks addressed human comments as no feedback" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[
        {"id": 100, "user": {"login": "ianwremmel", "type": "User"}, "body": "Please fix this variable name", "in_reply_to_id": null},
        {"id": 101, "user": {"login": "claude-agent", "type": "Bot"}, "body": "<!-- agent-reply -->Fixed the variable name as requested.", "in_reply_to_id": 100}
      ]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.has_feedback') == "false" ]]
}

@test "fetch_check_status detects unresolved copilot comments as copilot not clean" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [{"state": "COMMENTED", "author": {"login": "copilot"}}],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[
        {"id": 200, "user": {"login": "copilot", "type": "Bot"}, "body": "Consider using a const here.", "in_reply_to_id": null}
      ]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.copilot_clean') == "false" ]]
}

@test "fetch_check_status marks addressed copilot comments as copilot clean" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [{"state": "COMMENTED", "author": {"login": "copilot"}}],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    elif [[ $2 == *"/comments" ]]; then
      echo '[
        {"id": 200, "user": {"login": "copilot", "type": "Bot"}, "body": "Consider using a const here.", "in_reply_to_id": null},
        {"id": 201, "user": {"login": "claude-agent", "type": "Bot"}, "body": "<!-- agent-reply -->Updated to use const.", "in_reply_to_id": 200}
      ]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.copilot_clean') == "true" ]]
}

@test "fetch_check_status treats comments API failure as unresolved feedback" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/statuses" ]]; then
      _apply_jq_from_args "$@"
      return
    elif [[ $1 == "api" && $2 == *"/comments" ]]; then
      return 1
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo '{
        "state": "OPEN",
        "labels": [],
        "reviews": [{"state": "COMMENTED", "author": {"login": "copilot"}}],
        "reviewRequests": [],
        "headRefOid": "abc123"
      }'
    elif [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner": "owner/repo"}'
    elif [[ $2 == *"/statuses" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data

  run fetch_check_status "42"

  [[ $status -eq 0 ]]
  local json
  json=$(echo "$output" | grep -v '^Warning:')
  [[ $(echo "$json" | jq -r '.has_feedback') == "true" ]]
  [[ $(echo "$json" | jq -r '.copilot_clean') == "false" ]]
}
