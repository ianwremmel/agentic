#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/debug.bash"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# debug subcommand tests
# ============================================================================

@test "cmd_debug requires exactly 1 argument" {
  run cmd_debug

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_debug rejects too many arguments" {
  run cmd_debug "42" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "fetch_debug_state requires exactly 1 argument" {
  run fetch_debug_state

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "fetch_debug_state returns exit 1 on API failure" {
  gh() {
    return 1
  }
  export -f gh

  run fetch_debug_state "42"

  [[ $status -eq 1 ]]
  [[ $output == *"failed to fetch"* ]]
}

@test "fetch_debug_state returns complete debug state for open PR" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
    if [[ $1 == "repo" && $2 == "view" ]]; then
      echo "owner/repo"
      return
    fi
    if [[ $1 == "api" ]]; then
      if [[ $2 == *"/statuses" ]]; then
        _apply_jq_from_args "$@"
        return
      fi
      if [[ $2 == *"/comments"* ]]; then
        _apply_jq_from_args "$@"
        return
      fi
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      cat <<'RAWJSON'
{
  "state": "OPEN",
  "title": "feat(scripts): add debug subcommand",
  "isDraft": true,
  "labels": [{"name": "agent-working"}],
  "reviews": [{"state": "COMMENTED", "author": {"login": "copilot"}}],
  "reviewRequests": [],
  "headRefOid": "abc123",
  "headRefName": "feat/debug",
  "body": "Some PR body\n<!-- clc-progress\nphase: implementation\nci_fix_attempts: 0\n-->",
  "statusCheckRollup": [{"name": "buildkite/test", "status": "COMPLETED", "conclusion": "SUCCESS"}]
}
RAWJSON
      return
    fi
    if [[ $2 == *"/statuses" ]]; then
      echo '[{"context":"buildkite/test","state":"success","updated_at":"2026-01-01T00:00:00Z"}]'
      return
    fi
    if [[ $2 == *"/comments"* ]]; then
      echo '[{"id":100,"user":{"login":"bot"},"created_at":"2026-01-01T00:00:00Z","body":"Hello","reactions":{"total_count":1,"+1":1,"-1":0,"eyes":0,"rocket":0,"confused":0}}]'
      return
    fi
  }
  export -f _gh_raw_data

  git() {
    if [[ $1 == "worktree" ]]; then
      echo ""
    fi
  }
  export -f git

  run fetch_debug_state "42"

  [[ $status -eq 0 ]]
  local result
  result=$(echo "$output" | jq '.')
  [[ $(echo "$result" | jq -r '.pr_number') == "42" ]]
  [[ $(echo "$result" | jq -r '.state') == "OPEN" ]]
  [[ $(echo "$result" | jq -r '.title') == "feat(scripts): add debug subcommand" ]]
  [[ $(echo "$result" | jq -r '.is_draft') == "true" ]]
  [[ $(echo "$result" | jq -r '.head_sha') == "abc123" ]]
  [[ $(echo "$result" | jq -r '.head_branch') == "feat/debug" ]]
  [[ $(echo "$result" | jq -r '.labels[0]') == "agent-working" ]]
  [[ $(echo "$result" | jq -r '.ci_state') == "success" ]]
  [[ $(echo "$result" | jq -r '.checks[0].name') == "buildkite/test" ]]
  [[ $(echo "$result" | jq -r '.reviews[0].author') == "copilot" ]]
  [[ $(echo "$result" | jq -r '.progress.phase') == "implementation" ]]
  [[ $(echo "$result" | jq -r '.progress.ci_fix_attempts') == "0" ]]
  [[ $(echo "$result" | jq -r '.recent_comments[0].author') == "bot" ]]
  [[ $(echo "$result" | jq '.recent_comments[0].reactions."+1"') == "1" ]]
  [[ $(echo "$result" | jq -r '.lock') == "null" ]]
}

@test "fetch_debug_state returns merged PR state" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
    if [[ $1 == "repo" && $2 == "view" ]]; then
      echo "owner/repo"
      return
    fi
    if [[ $1 == "api" ]]; then
      if [[ $2 == *"/statuses" ]]; then
        _apply_jq_from_args "$@"
        return
      fi
      if [[ $2 == *"/comments"* ]]; then
        echo "[]"
        return
      fi
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      cat <<'RAWJSON'
{
  "state": "MERGED",
  "title": "feat(scripts): merged PR",
  "isDraft": false,
  "labels": [],
  "reviews": [],
  "reviewRequests": [],
  "headRefOid": "def456",
  "headRefName": "feat/merged",
  "body": "",
  "statusCheckRollup": []
}
RAWJSON
      return
    fi
    if [[ $2 == *"/statuses" ]]; then
      echo '[]'
      return
    fi
  }
  export -f _gh_raw_data

  git() {
    if [[ $1 == "worktree" ]]; then
      echo ""
    fi
  }
  export -f git

  run fetch_debug_state "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.state') == "MERGED" ]]
  [[ $(echo "$output" | jq -r '.is_draft') == "false" ]]
  [[ $(echo "$output" | jq -r '.progress') == "{}" ]]
}

@test "fetch_debug_state handles PR with no progress block" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
    if [[ $1 == "repo" && $2 == "view" ]]; then
      echo "owner/repo"
      return
    fi
    if [[ $1 == "api" ]]; then
      if [[ $2 == *"/statuses" ]]; then
        echo '[]'
        return
      fi
      if [[ $2 == *"/comments"* ]]; then
        echo '[]'
        return
      fi
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      cat <<'RAWJSON'
{
  "state": "OPEN",
  "title": "chore: no progress",
  "isDraft": false,
  "labels": [],
  "reviews": [],
  "reviewRequests": [],
  "headRefOid": "abc000",
  "headRefName": "chore/no-progress",
  "body": "Just a regular PR body with no progress block",
  "statusCheckRollup": []
}
RAWJSON
      return
    fi
  }
  export -f _gh_raw_data

  git() {
    if [[ $1 == "worktree" ]]; then
      echo ""
    fi
  }
  export -f git

  run fetch_debug_state "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.progress') == "{}" ]]
}

@test "fetch_debug_state includes status files when present" {
  local status_dir="/tmp/claude/issue-status"
  mkdir -p "$status_dir"
  echo '{"state":"pushed","summary":"test"}' > "${status_dir}/CLC-TEST-DEBUG.json"

  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
    if [[ $1 == "repo" && $2 == "view" ]]; then
      echo "owner/repo"
      return
    fi
    if [[ $1 == "api" ]]; then
      if [[ $2 == *"/statuses" ]]; then
        echo '[]'
        return
      fi
      if [[ $2 == *"/comments"* ]]; then
        echo '[]'
        return
      fi
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      cat <<'RAWJSON'
{
  "state": "OPEN",
  "title": "test",
  "isDraft": false,
  "labels": [],
  "reviews": [],
  "reviewRequests": [],
  "headRefOid": "abc000",
  "headRefName": "test/branch",
  "body": "",
  "statusCheckRollup": []
}
RAWJSON
      return
    fi
  }
  export -f _gh_raw_data

  git() {
    if [[ $1 == "worktree" ]]; then
      echo ""
    fi
  }
  export -f git

  run fetch_debug_state "42"

  rm -f "${status_dir}/CLC-TEST-DEBUG.json"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.status_files | length') -ge 1 ]]
  [[ $(echo "$output" | jq -r '.status_files[] | select(.file == "CLC-TEST-DEBUG.json") | .content.state') == "pushed" ]]
}

@test "fetch_debug_state finds worktree for branch" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
    if [[ $1 == "repo" && $2 == "view" ]]; then
      echo "owner/repo"
      return
    fi
    if [[ $1 == "api" ]]; then
      if [[ $2 == *"/statuses" ]]; then
        echo '[]'
        return
      fi
      if [[ $2 == *"/comments"* ]]; then
        echo '[]'
        return
      fi
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      cat <<'RAWJSON'
{
  "state": "OPEN",
  "title": "test",
  "isDraft": false,
  "labels": [],
  "reviews": [],
  "reviewRequests": [],
  "headRefOid": "abc000",
  "headRefName": "feat/my-branch",
  "body": "",
  "statusCheckRollup": []
}
RAWJSON
      return
    fi
  }
  export -f _gh_raw_data

  git() {
    if [[ $1 == "worktree" ]]; then
      printf 'worktree /home/user/worktrees/feat_my-branch\nbranch refs/heads/feat/my-branch\n'
      return
    fi
  }
  export -f git

  run fetch_debug_state "42"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.worktree.path') == "/home/user/worktrees/feat_my-branch" ]]
}

@test "fetch_debug_state includes lock file when present" {
  local lock_dir="/tmp/claude/project-state/locks"
  mkdir -p "$lock_dir"
  echo '{"timestamp":"2026-01-01T00:00:00Z","action":"feedback"}' > "${lock_dir}/42.json"

  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      _apply_jq_from_args "$@"
      return
    fi
    if [[ $1 == "repo" && $2 == "view" ]]; then
      echo "owner/repo"
      return
    fi
    if [[ $1 == "api" ]]; then
      if [[ $2 == *"/statuses" ]]; then
        echo '[]'
        return
      fi
      if [[ $2 == *"/comments"* ]]; then
        echo '[]'
        return
      fi
    fi
  }
  export -f gh

  _gh_raw_data() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      cat <<'RAWJSON'
{
  "state": "OPEN",
  "title": "test",
  "isDraft": false,
  "labels": [{"name": "agent-working"}],
  "reviews": [],
  "reviewRequests": [],
  "headRefOid": "abc000",
  "headRefName": "test/branch",
  "body": "",
  "statusCheckRollup": []
}
RAWJSON
      return
    fi
  }
  export -f _gh_raw_data

  git() {
    if [[ $1 == "worktree" ]]; then
      echo ""
    fi
  }
  export -f git

  run fetch_debug_state "42"

  rm -f "${lock_dir}/42.json"

  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.lock.content.action') == "feedback" ]]
  [[ $(echo "$output" | jq -r '.lock.age_minutes') != "null" ]]
}
