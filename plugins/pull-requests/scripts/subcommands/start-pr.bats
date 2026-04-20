#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/start-pr"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# start-pr subcommand tests
# ============================================================================

@test "derive_pr_title strips date suffix and converts hyphens" {
  run derive_pr_title "clc-539-featscripts-add-orchestrate-start-pr-2026-03-17T021549"

  [[ $status -eq 0 ]]
  [[ $output == "Clc 539 featscripts add orchestrate start pr" ]]
}

@test "derive_pr_title with ticket_id strips prefix and adds ticket ID" {
  run derive_pr_title "clc-539-featscripts-add-start-pr-2026-03-17T021549" "CLC-539"

  [[ $status -eq 0 ]]
  [[ $output == "CLC-539: Featscripts add start pr" ]]
}

@test "derive_pr_title handles branch without date suffix" {
  run derive_pr_title "feature-my-cool-thing"

  [[ $status -eq 0 ]]
  [[ $output == "Feature my cool thing" ]]
}

@test "derive_pr_title requires at least 1 argument" {
  run derive_pr_title

  [[ $status -eq 2 ]]
  [[ $output == *"requires at least 1 argument"* ]]
}

@test "generate_pr_body includes progress block" {
  run generate_pr_body "" ""

  [[ $status -eq 0 ]]
  [[ $output == *"## Summary"* ]]
  [[ $output == *"## Progress"* ]]
  [[ $output == *"<!-- clc-progress"* ]]
  [[ $output == *"phase: implementation"* ]]
  [[ $output == *"implementation_complete: false"* ]]
}

@test "generate_pr_body includes ticket link when provided" {
  run generate_pr_body "CLC-100" "https://linear.app/test/issue/CLC-100"

  [[ $status -eq 0 ]]
  [[ $output == *"Resolves [CLC-100](https://linear.app/test/issue/CLC-100)"* ]]
}

@test "generate_pr_body omits ticket link when not provided" {
  run generate_pr_body "" ""

  [[ $status -eq 0 ]]
  [[ $output != *"Resolves"* ]]
}

@test "append_active_pr creates file when it does not exist" {
  local test_dir
  test_dir=$(mktemp -d)
  ACTIVE_PRS_DIR="$test_dir"
  ACTIVE_PRS_FILE="${test_dir}/active-prs.json"

  run append_active_pr "42" "my-branch" "/tmp/worktree" "CLC-100" "https://linear.app/test"

  [[ $status -eq 0 ]]
  [[ -f "${test_dir}/active-prs.json" ]]

  local pr_number
  pr_number=$(jq '.[0].pr_number' "${test_dir}/active-prs.json")
  [[ $pr_number == "42" ]]

  local branch_name
  branch_name=$(jq -r '.[0].branch_name' "${test_dir}/active-prs.json")
  [[ $branch_name == "my-branch" ]]

  rm -rf "$test_dir"
}

@test "append_active_pr appends to existing file" {
  local test_dir
  test_dir=$(mktemp -d)
  ACTIVE_PRS_DIR="$test_dir"
  ACTIVE_PRS_FILE="${test_dir}/active-prs.json"
  echo '[{"pr_number":1,"branch_name":"old","worktree_dir":"/tmp/old","ticket_id":"","ticket_url":""}]' > "${test_dir}/active-prs.json"

  run append_active_pr "42" "my-branch" "/tmp/worktree" "" ""

  [[ $status -eq 0 ]]
  local count
  count=$(jq 'length' "${test_dir}/active-prs.json")
  [[ $count == "2" ]]

  local second_pr
  second_pr=$(jq '.[1].pr_number' "${test_dir}/active-prs.json")
  [[ $second_pr == "42" ]]

  rm -rf "$test_dir"
}

@test "append_active_pr requires at least 3 arguments" {
  run append_active_pr "42" "my-branch"

  [[ $status -eq 2 ]]
  [[ $output == *"requires at least 3 arguments"* ]]
}

@test "cmd_start_pr requires at least 1 argument" {
  run cmd_start_pr

  [[ $status -eq 1 ]]
  [[ $output == *"requires at least 1 argument"* ]]
}

@test "cmd_start_pr fails for non-existent directory" {
  run cmd_start_pr "/nonexistent/path"

  [[ $status -eq 1 ]]
  [[ $output == *"worktree directory does not exist"* ]]
}

@test "cmd_start_pr rejects unknown options" {
  local test_dir
  test_dir=$(mktemp -d)

  run cmd_start_pr "$test_dir" --unknown-flag "value"

  [[ $status -eq 1 ]]
  [[ $output == *"unknown option"* ]]

  rm -rf "$test_dir"
}

@test "cmd_start_pr creates draft PR and returns JSON" {
  local test_dir
  test_dir=$(mktemp -d)
  local state_dir
  state_dir=$(mktemp -d)
  ACTIVE_PRS_DIR="$state_dir"
  ACTIVE_PRS_FILE="${state_dir}/active-prs.json"

  git() {
    if [[ $1 == "-C" && $3 == "rev-parse" ]]; then
      echo "my-feature-branch"
      return 0
    elif [[ $1 == "-C" && $3 == "commit" ]]; then
      return 0
    elif [[ $1 == "-C" && $3 == "push" ]]; then
      return 0
    fi
    return 0
  }
  export -f git

  gh() {
    if [[ $1 == "pr" && $2 == "create" ]]; then
      echo "https://github.com/owner/repo/pull/99"
      return 0
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      echo "owner/repo"
      return 0
    fi
    return 0
  }
  export -f gh

  run cmd_start_pr "$test_dir"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.pr_number == 99'
  echo "$output" | jq -e '.pr_url == "https://github.com/owner/repo/pull/99"'
  echo "$output" | jq -e '.branch_name == "my-feature-branch"'

  # Verify active-prs.json was updated
  [[ -f "${state_dir}/active-prs.json" ]]
  local stored_pr
  stored_pr=$(jq '.[0].pr_number' "${state_dir}/active-prs.json")
  [[ $stored_pr == "99" ]]

  rm -rf "$test_dir" "$state_dir"
}

@test "cmd_start_pr passes ticket info to PR body and title" {
  local test_dir
  test_dir=$(mktemp -d)
  local state_dir
  state_dir=$(mktemp -d)
  ACTIVE_PRS_DIR="$state_dir"
  ACTIVE_PRS_FILE="${state_dir}/active-prs.json"

  git() {
    if [[ $1 == "-C" && $3 == "rev-parse" ]]; then
      echo "clc-100-my-feature-2026-01-01T000000"
      return 0
    elif [[ $1 == "-C" && $3 == "commit" ]]; then
      return 0
    elif [[ $1 == "-C" && $3 == "push" ]]; then
      return 0
    fi
    return 0
  }
  export -f git

  gh() {
    if [[ $1 == "pr" && $2 == "create" ]]; then
      echo "https://github.com/owner/repo/pull/55"
      return 0
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      echo "owner/repo"
      return 0
    fi
    return 0
  }
  export -f gh

  run cmd_start_pr "$test_dir" --ticket-id "CLC-100" --ticket-url "https://linear.app/test/CLC-100"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.pr_number == 55'

  # Verify ticket info in active-prs.json
  local ticket_id
  ticket_id=$(jq -r '.[0].ticket_id' "${state_dir}/active-prs.json")
  [[ $ticket_id == "CLC-100" ]]

  rm -rf "$test_dir" "$state_dir"
}

@test "cmd_start_pr fails when ticket-id flag has no value" {
  local test_dir
  test_dir=$(mktemp -d)

  run cmd_start_pr "$test_dir" --ticket-id

  [[ $status -eq 1 ]]
  [[ $output == *"--ticket-id requires a value"* ]]

  rm -rf "$test_dir"
}

@test "cmd_start_pr resolves relative worktree_dir to absolute path in active-prs.json" {
  local test_dir
  test_dir=$(mktemp -d)
  local state_dir
  state_dir=$(mktemp -d)
  ACTIVE_PRS_DIR="$state_dir"
  ACTIVE_PRS_FILE="${state_dir}/active-prs.json"

  git() {
    if [[ $1 == "-C" && $3 == "rev-parse" ]]; then
      echo "my-feature-branch"
      return 0
    elif [[ $1 == "-C" && $3 == "commit" ]]; then
      return 0
    elif [[ $1 == "-C" && $3 == "push" ]]; then
      return 0
    fi
    return 0
  }
  export -f git

  gh() {
    if [[ $1 == "pr" && $2 == "create" ]]; then
      echo "https://github.com/owner/repo/pull/77"
      return 0
    elif [[ $1 == "repo" && $2 == "view" ]]; then
      echo "owner/repo"
      return 0
    fi
    return 0
  }
  export -f gh

  # Pass a relative path by cd-ing to parent and using basename
  local dir_name
  dir_name=$(basename "$test_dir")
  local parent_dir
  parent_dir=$(dirname "$test_dir")

  run bash -c "
    source ./scripts/orchestrate
    retry() { shift 2; \"\$@\"; }
    export -f retry
    $(declare -f git)
    export -f git
    $(declare -f gh)
    export -f gh
    ACTIVE_PRS_DIR='$state_dir'
    ACTIVE_PRS_FILE='${state_dir}/active-prs.json'
    cd '$parent_dir' && cmd_start_pr './$dir_name'
  "

  [[ $status -eq 0 ]]

  # Verify the stored worktree_dir is absolute (starts with /)
  local stored_dir
  stored_dir=$(jq -r '.[0].worktree_dir' "${state_dir}/active-prs.json")
  [[ $stored_dir == /* ]]
  # Verify it resolves to the same directory (canonicalized)
  local expected_dir
  expected_dir=$(cd "$test_dir" && pwd -P)
  [[ $stored_dir == "$expected_dir" ]]

  rm -rf "$test_dir" "$state_dir"
}
