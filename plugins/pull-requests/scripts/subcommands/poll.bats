#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/poll"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# poll subcommand tests
# ============================================================================

@test "get_pr_info requires exactly 1 argument" {
  run get_pr_info

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "get_pr_info rejects too many arguments" {
  run get_pr_info "42" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "get_pr_info returns merged JSON with state, author, and mergeable" {
  gh() {
    echo '{"pr_state":"OPEN","pr_author":"ianwremmel","mergeable":"MERGEABLE"}'
  }
  export -f gh

  run get_pr_info "42"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.pr_state == "OPEN"'
  echo "$output" | jq -e '.pr_author == "ianwremmel"'
  echo "$output" | jq -e '.mergeable == "MERGEABLE"'
}

@test "get_bk_status requires exactly 1 argument" {
  run get_bk_status

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "get_bk_status rejects too many arguments" {
  run get_bk_status "abc123" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "get_bk_status returns correct JSON for buildkite status" {
  _gh_raw_data() {
    if [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner":"owner/repo"}'
    elif [[ $1 == "api" ]]; then
      echo '[{"state":"success","description":"Build passed","target_url":"https://buildkite.com/build/1","context":"buildkite/apps","updated_at":"2026-01-01T00:00:00Z"},{"state":"pending","description":"waiting","target_url":"https://example.com","context":"other-ci","updated_at":"2026-01-01T00:00:00Z"}]'
    fi
  }
  export -f _gh_raw_data
  gh() { _apply_jq_from_args "$@"; }
  export -f gh

  run get_bk_status "abc123"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.bk_state == "success"'
  echo "$output" | jq -e '.bk_desc == "Build passed"'
  echo "$output" | jq -e '.bk_url == "https://buildkite.com/build/1"'
}

@test "get_bk_status returns empty when no buildkite status" {
  _gh_raw_data() {
    if [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner":"owner/repo"}'
    elif [[ $1 == "api" ]]; then
      echo '[]'
    fi
  }
  export -f _gh_raw_data
  gh() { _apply_jq_from_args "$@"; }
  export -f gh

  run get_bk_status "abc123"

  [[ $status -eq 0 ]]
  [[ -z $output ]]
}

@test "fetch_new_comments filters agent replies" {
  _gh_raw_data() {
    if [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner":"owner/repo"}'
    elif [[ $1 == "api" ]]; then
      echo '[{"id":200,"body":"fix this","path":"src/foo.ts","user":{"login":"reviewer1","type":"User"},"in_reply_to_id":null},{"id":201,"body":"<!-- agent-reply --> done","path":"src/foo.ts","user":{"login":"bot","type":"User"},"in_reply_to_id":200}]'
    fi
  }
  export -f _gh_raw_data
  gh() { _apply_jq_from_args "$@"; }
  export -f gh

  run fetch_new_comments "42" 0

  [[ $status -eq 0 ]]
  echo "$output" | jq -e 'length == 1'
  echo "$output" | jq -e '.[0].id == 200'
}

@test "fetch_new_issue_comments filters bots but keeps copilot" {
  _gh_raw_data() {
    if [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner":"owner/repo"}'
    elif [[ $1 == "api" ]]; then
      echo '[{"id":300,"body":"looks good","user":{"login":"testuser","type":"User"}},{"id":301,"body":"automated","user":{"login":"somebot","type":"Bot"}},{"id":302,"body":"copilot says","user":{"login":"copilot","type":"Bot"}}]'
    fi
  }
  export -f _gh_raw_data
  gh() { _apply_jq_from_args "$@"; }
  export -f gh

  run fetch_new_issue_comments "42" 0

  [[ $status -eq 0 ]]
  echo "$output" | jq -e 'length == 2'
  echo "$output" | jq -e '[.[].user_login] | sort == ["copilot", "testuser"]'
}

@test "fetch_new_issue_comments filters agent replies from non-bots" {
  _gh_raw_data() {
    if [[ $1 == "repo" ]]; then
      echo '{"nameWithOwner":"owner/repo"}'
    elif [[ $1 == "api" ]]; then
      echo '[{"id":300,"body":"real comment","user":{"login":"testuser","type":"User"}},{"id":301,"body":"<!-- agent-reply --> handled","user":{"login":"testuser","type":"User"}}]'
    fi
  }
  export -f _gh_raw_data
  gh() { _apply_jq_from_args "$@"; }
  export -f gh

  run fetch_new_issue_comments "42" 0

  [[ $status -eq 0 ]]
  echo "$output" | jq -e 'length == 1'
  echo "$output" | jq -e '.[0].id == 300'
}

@test "compute_max_id returns max from array" {
  run compute_max_id '[{"id":10},{"id":50},{"id":30}]' 0

  [[ $status -eq 0 ]]
  [[ $output == "50" ]]
}

@test "compute_max_id returns watermark for empty array" {
  run compute_max_id '[]' 42

  [[ $status -eq 0 ]]
  [[ $output == "42" ]]
}

@test "compute_approval_state requires exactly 1 argument" {
  run compute_approval_state

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "compute_approval_state returns PENDING when no actionable reviews" {
  run compute_approval_state '[]'

  [[ $status -eq 0 ]]
  [[ $output == "PENDING" ]]
}

@test "compute_approval_state returns PENDING when only COMMENTED reviews" {
  run compute_approval_state '[{"id":1,"state":"COMMENTED","user_login":"alice"},{"id":2,"state":"COMMENTED","user_login":"bob"}]'

  [[ $status -eq 0 ]]
  [[ $output == "PENDING" ]]
}

@test "compute_approval_state returns APPROVED when latest per-user is approved" {
  run compute_approval_state '[{"id":1,"state":"CHANGES_REQUESTED","user_login":"alice"},{"id":2,"state":"APPROVED","user_login":"alice"}]'

  [[ $status -eq 0 ]]
  [[ $output == "APPROVED" ]]
}

@test "compute_approval_state returns CHANGES_REQUESTED when any user latest is changes_requested" {
  run compute_approval_state '[{"id":1,"state":"APPROVED","user_login":"alice"},{"id":2,"state":"CHANGES_REQUESTED","user_login":"bob"}]'

  [[ $status -eq 0 ]]
  [[ $output == "CHANGES_REQUESTED" ]]
}

@test "compute_approval_state ignores COMMENTED and DISMISSED reviews" {
  run compute_approval_state '[{"id":1,"state":"APPROVED","user_login":"alice"},{"id":2,"state":"COMMENTED","user_login":"alice"},{"id":3,"state":"DISMISSED","user_login":"bob"}]'

  [[ $status -eq 0 ]]
  [[ $output == "APPROVED" ]]
}

@test "compute_approval_state handles multiple reviewers mixed" {
  run compute_approval_state '[{"id":1,"state":"APPROVED","user_login":"alice"},{"id":2,"state":"APPROVED","user_login":"bob"},{"id":3,"state":"CHANGES_REQUESTED","user_login":"bob"}]'

  [[ $status -eq 0 ]]
  [[ $output == "CHANGES_REQUESTED" ]]
}

@test "bk_terminal is true for failed" {
  local result
  result=$(jq -n --argjson bk '{"bk_state":"failure","bk_desc":"Build #123 failed"}' \
    '($bk.bk_state == "error") or ($bk.bk_state == "failure" and ($bk.bk_desc | contains("failed")))')

  [[ $result == "true" ]]
}

@test "bk_terminal is false for failing" {
  local result
  result=$(jq -n --argjson bk '{"bk_state":"failure","bk_desc":"Build #123 failing"}' \
    '($bk.bk_state == "error") or ($bk.bk_state == "failure" and ($bk.bk_desc | contains("failed")))')

  [[ $result == "false" ]]
}

@test "bk_terminal is false for pending" {
  local result
  result=$(jq -n --argjson bk '{"bk_state":"pending","bk_desc":"running"}' \
    '($bk.bk_state == "error") or ($bk.bk_state == "failure" and ($bk.bk_desc | contains("failed")))')

  [[ $result == "false" ]]
}

@test "bk_terminal is true for error state regardless of description" {
  local result
  result=$(jq -n --argjson bk '{"bk_state":"error","bk_desc":"Build canceled"}' \
    '($bk.bk_state == "error") or ($bk.bk_state == "failure" and ($bk.bk_desc | contains("failed")))')

  [[ $result == "true" ]]
}

@test "has_new_feedback is true when reviews non-empty" {
  local result
  result=$(jq -n \
    --argjson reviews '[{"id":1}]' \
    --argjson comments '[]' \
    --argjson issue_comments '[]' \
    '(($reviews | length) > 0 or ($comments | length) > 0 or ($issue_comments | length) > 0)')

  [[ $result == "true" ]]
}

@test "has_new_feedback is false when all empty" {
  local result
  result=$(jq -n \
    --argjson reviews '[]' \
    --argjson comments '[]' \
    --argjson issue_comments '[]' \
    '(($reviews | length) > 0 or ($comments | length) > 0 or ($issue_comments | length) > 0)')

  [[ $result == "false" ]]
}

@test "fetch_copilot_comments requires 1-2 arguments" {
  run fetch_copilot_comments

  [[ $status -eq 2 ]]
  [[ $output == *"requires 1-2 arguments"* ]]
}

@test "fetch_copilot_comments rejects too many arguments" {
  run fetch_copilot_comments "42" "sha1" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires 1-2 arguments"* ]]
}

@test "enrich_with_reactions adds reactions array to comments" {
  # Stub gh to return reactions for comment 100
  # The function uses --jq '.[] | {content, user: {login}}' then pipes to jq -s
  # so the stub must return individual JSON objects (one per line), not an array
  gh() {
    if [[ $* == *"/100/reactions"* ]]; then
      printf '%s\n' '{"content":"+1","user":{"login":"testuser"}}' '{"content":"heart","user":{"login":"other"}}'
    elif [[ $* == *"nameWithOwner"* ]]; then
      echo "owner/repo"
    else
      echo ""
    fi
  }
  export -f gh

  local result
  result=$(enrich_with_reactions '[{"id":100,"body":"fix this","path":"file.sh","commit_id":"abc"}]')

  echo "$result" | jq -e '.[0].reactions | length == 2'
  echo "$result" | jq -e '.[0].reactions[0].content == "+1"'
  echo "$result" | jq -e '.[0].reactions[0].user.login == "testuser"'
}

@test "get_authenticated_user rejects arguments" {
  run get_authenticated_user "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"Usage: get_authenticated_user"* ]]
}

@test "copilot_clean_review is true when copilot reviewed and no unresolved comments on HEAD" {
  local result
  result=$(jq -n \
    --argjson all_reviews '[{"user_login":"copilot-pull-request-reviewer[bot]","state":"APPROVED"}]' \
    --argjson copilot_comments '[]' \
    --arg agent_login "testuser" \
    --arg head_sha "abc123" \
    '(
      ($all_reviews | any(.user_login | ascii_downcase | startswith("copilot"))) and
      ([$copilot_comments[]
        | select(.commit_id == $head_sha)
        | select(.reactions | all(
            (.content != "+1" and .content != "-1") or .user.login != $agent_login
          ))
      ] | length == 0)
    )')

  [[ $result == "true" ]]
}

@test "copilot_clean_review is false when no copilot review exists (uses all_reviews)" {
  local result
  result=$(jq -n \
    --argjson all_reviews '[{"user_login":"human","state":"APPROVED"}]' \
    --argjson copilot_comments '[]' \
    --arg agent_login "testuser" \
    --arg head_sha "abc123" \
    '(
      ($all_reviews | any(.user_login | ascii_downcase | startswith("copilot"))) and
      ([$copilot_comments[]
        | select(.commit_id == $head_sha)
        | select(.reactions | all(
            (.content != "+1" and .content != "-1") or .user.login != $agent_login
          ))
      ] | length == 0)
    )')

  [[ $result == "false" ]]
}

@test "copilot_clean_review ignores copilot comments on stale commits" {
  local result
  result=$(jq -n \
    --argjson all_reviews '[{"user_login":"copilot","state":"COMMENTED"}]' \
    --argjson copilot_comments '[{"id":1,"body":"fix","path":"f.sh","commit_id":"old_sha","reactions":[]}]' \
    --arg agent_login "testuser" \
    --arg head_sha "new_sha" \
    '(
      ($all_reviews | any(.user_login | ascii_downcase | startswith("copilot"))) and
      ([$copilot_comments[]
        | select(.commit_id == $head_sha)
        | select(.reactions | all(
            (.content != "+1" and .content != "-1") or .user.login != $agent_login
          ))
      ] | length == 0)
    )')

  [[ $result == "true" ]]
}

@test "copilot_clean_review treats comment with agent +1 reaction as resolved" {
  local result
  result=$(jq -n \
    --argjson all_reviews '[{"user_login":"copilot","state":"COMMENTED"}]' \
    --argjson copilot_comments '[{"id":1,"body":"fix","path":"f.sh","commit_id":"abc123","reactions":[{"content":"+1","user":{"login":"testuser"}}]}]' \
    --arg agent_login "testuser" \
    --arg head_sha "abc123" \
    '(
      ($all_reviews | any(.user_login | ascii_downcase | startswith("copilot"))) and
      ([$copilot_comments[]
        | select(.commit_id == $head_sha)
        | select(.reactions | all(
            (.content != "+1" and .content != "-1") or .user.login != $agent_login
          ))
      ] | length == 0)
    )')

  [[ $result == "true" ]]
}

@test "copilot_clean_review treats comment with agent -1 reaction as resolved" {
  local result
  result=$(jq -n \
    --argjson all_reviews '[{"user_login":"copilot","state":"COMMENTED"}]' \
    --argjson copilot_comments '[{"id":1,"body":"fix","path":"f.sh","commit_id":"abc123","reactions":[{"content":"-1","user":{"login":"testuser"}}]}]' \
    --arg agent_login "testuser" \
    --arg head_sha "abc123" \
    '(
      ($all_reviews | any(.user_login | ascii_downcase | startswith("copilot"))) and
      ([$copilot_comments[]
        | select(.commit_id == $head_sha)
        | select(.reactions | all(
            (.content != "+1" and .content != "-1") or .user.login != $agent_login
          ))
      ] | length == 0)
    )')

  [[ $result == "true" ]]
}

@test "copilot_clean_review is false when comment has non-agent reaction only" {
  local result
  result=$(jq -n \
    --argjson all_reviews '[{"user_login":"copilot","state":"COMMENTED"}]' \
    --argjson copilot_comments '[{"id":1,"body":"fix","path":"f.sh","commit_id":"abc123","reactions":[{"content":"+1","user":{"login":"someone_else"}}]}]' \
    --arg agent_login "testuser" \
    --arg head_sha "abc123" \
    '(
      ($all_reviews | any(.user_login | ascii_downcase | startswith("copilot"))) and
      ([$copilot_comments[]
        | select(.commit_id == $head_sha)
        | select(.reactions | all(
            (.content != "+1" and .content != "-1") or .user.login != $agent_login
          ))
      ] | length == 0)
    )')

  [[ $result == "false" ]]
}

@test "copilot_clean_review is false when unresolved copilot comment on HEAD" {
  local result
  result=$(jq -n \
    --argjson all_reviews '[{"user_login":"copilot","state":"COMMENTED"}]' \
    --argjson copilot_comments '[{"id":1,"body":"fix this","path":"f.sh","commit_id":"abc123","reactions":[]}]' \
    --arg agent_login "testuser" \
    --arg head_sha "abc123" \
    '(
      ($all_reviews | any(.user_login | ascii_downcase | startswith("copilot"))) and
      ([$copilot_comments[]
        | select(.commit_id == $head_sha)
        | select(.reactions | all(
            (.content != "+1" and .content != "-1") or .user.login != $agent_login
          ))
      ] | length == 0)
    )')

  [[ $result == "false" ]]
}

@test "fetch_new_comments rejects non-numeric watermark" {
  run fetch_new_comments "42" "abc"

  [[ $status -eq 2 ]]
  [[ $output == *"watermark must be a non-negative integer"* ]]
}

@test "fetch_new_issue_comments rejects non-numeric watermark" {
  run fetch_new_issue_comments "42" "abc"

  [[ $status -eq 2 ]]
  [[ $output == *"watermark must be a non-negative integer"* ]]
}

@test "cmd_poll rejects non-numeric review watermark" {
  run cmd_poll 42 abc123 --review-watermark "bad"

  [[ $status -eq 2 ]]
  [[ $output == *"watermark must be a non-negative integer"* ]]
}

@test "cmd_poll requires pr_number" {
  run cmd_poll

  [[ $status -eq 1 ]]
  [[ $output == *"pr_number is required"* ]]
}

@test "cmd_poll requires sha" {
  run cmd_poll 42

  [[ $status -eq 1 ]]
  [[ $output == *"sha is required"* ]]
}

@test "cmd_poll rejects unknown options" {
  run cmd_poll --bogus 42

  [[ $status -eq 1 ]]
  [[ $output == *"unknown option"* ]]
}

@test "cmd_poll rejects extra positional arguments" {
  run cmd_poll 42 abc123 extra

  [[ $status -eq 1 ]]
  [[ $output == *"unexpected argument"* ]]
}

# Helper to set up default stubs for cmd_poll integration tests
stub_poll_dependencies() {
  get_pr_info() {
    echo '{"pr_state":"OPEN","pr_author":"testuser","mergeable":"MERGEABLE"}'
  }
  export -f get_pr_info

  get_bk_status() {
    echo '{"bk_state":"success","bk_desc":"Build passed","bk_url":"https://buildkite.com/build/1"}'
  }
  export -f get_bk_status

  fetch_all_reviews() {
    echo '[{"id":100,"state":"APPROVED","body":"lgtm","user_login":"reviewer1","user_type":"User","commit_id":"abc123"}]'
  }
  export -f fetch_all_reviews

  fetch_new_comments() {
    echo '[]'
  }
  export -f fetch_new_comments

  fetch_new_issue_comments() {
    echo '[]'
  }
  export -f fetch_new_issue_comments

  fetch_copilot_comments() {
    echo '[]'
  }
  export -f fetch_copilot_comments

  enrich_with_reactions() {
    echo "$1"
  }
  export -f enrich_with_reactions

  get_authenticated_user() {
    echo "testuser"
  }
  export -f get_authenticated_user

  resolve_thread_context() {
    echo "$2"
  }
  export -f resolve_thread_context

  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return 0
    fi
  }
  export -f gh
}

@test "cmd_poll merges all fields" {
  stub_poll_dependencies

  run cmd_poll 42 abc123

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.pr_state == "OPEN"'
  echo "$output" | jq -e '.pr_author == "testuser"'
  echo "$output" | jq -e '.mergeable == "MERGEABLE"'
  echo "$output" | jq -e '.bk_state == "success"'
  echo "$output" | jq -e '.approval_state == "APPROVED"'
  echo "$output" | jq -e '.has_new_feedback == true'
  echo "$output" | jq -e '.bk_terminal == false'
  echo "$output" | jq -e '.reviews | length == 1'
  echo "$output" | jq -e '.watermarks.review == 100'
}

@test "cmd_poll handles missing BK status" {
  stub_poll_dependencies

  get_bk_status() {
    echo ""
  }
  export -f get_bk_status

  fetch_all_reviews() {
    echo '[]'
  }
  export -f fetch_all_reviews

  run cmd_poll 42 abc123

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.pr_state == "OPEN"'
  echo "$output" | jq -e '.bk_state == ""'
  echo "$output" | jq -e '.bk_terminal == false'
  echo "$output" | jq -e '.has_new_feedback == false'
  echo "$output" | jq -e '.approval_state == "PENDING"'
}

@test "cmd_poll parses watermark flags" {
  stub_poll_dependencies

  get_bk_status() {
    echo '{"bk_state":"pending","bk_desc":"running","bk_url":"https://bk.com/1"}'
  }
  export -f get_bk_status

  fetch_all_reviews() {
    echo '[{"id":5,"state":"COMMENTED","body":"hi","user_login":"alice","user_type":"User","commit_id":"aaa"}]'
  }
  export -f fetch_all_reviews

  run cmd_poll 42 abc123 --review-watermark 10 --comment-watermark 20 --issue-comment-watermark 30

  [[ $status -eq 0 ]]
  # Review id 5 < watermark 10, so new_reviews should be empty
  echo "$output" | jq -e '.reviews | length == 0'
  echo "$output" | jq -e '.has_new_feedback == false'
  # Watermarks preserved when no new items
  echo "$output" | jq -e '.watermarks.review == 10'
  echo "$output" | jq -e '.watermarks.comment == 20'
  echo "$output" | jq -e '.watermarks.issue_comment == 30'
}

# ============================================================================
# thread context resolution tests
# ============================================================================

@test "fetch_parent_comment requires exactly 2 arguments" {
  run fetch_parent_comment "owner/repo"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]
}

@test "fetch_parent_comment calls correct API endpoint" {
  gh() {
    if [[ $1 == "api" ]]; then
      echo "API_PATH=$2"
      return 0
    fi
  }
  export -f gh

  run fetch_parent_comment "owner/repo" "12300"

  [[ $status -eq 0 ]]
  [[ $output == *"repos/owner/repo/pulls/comments/12300"* ]]
}

@test "resolve_thread_context requires exactly 2 arguments" {
  run resolve_thread_context "owner/repo"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 2 arguments"* ]]
}

@test "resolve_thread_context passes through comments without in_reply_to_id" {
  local comments='[{"id":1,"body":"hello","in_reply_to_id":null}]'

  run resolve_thread_context "owner/repo" "$comments"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.[0].id == 1'
  echo "$output" | jq -e '.[0] | has("thread_context") | not'
}

@test "resolve_thread_context fetches and attaches parent comment" {
  fetch_parent_comment() {
    local repo="$1"
    local comment_id="$2"
    if [[ $comment_id == "100" ]]; then
      echo '{"id":100,"body":"Original comment","user_login":"reviewer1","path":"src/main.ts"}'
    fi
  }
  export -f fetch_parent_comment

  local comments='[{"id":200,"body":"Reply to original","in_reply_to_id":100}]'

  run resolve_thread_context "owner/repo" "$comments"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.[0].thread_context.id == 100'
  echo "$output" | jq -e '.[0].thread_context.body == "Original comment"'
  echo "$output" | jq -e '.[0].thread_context.user_login == "reviewer1"'
  echo "$output" | jq -e '.[0].thread_context.path == "src/main.ts"'
}

@test "resolve_thread_context deduplicates parent fetches for multiple replies" {
  local fetch_count_file="${BATS_TEST_TMPDIR}/bats_fetch_count"
  FETCH_COUNT=0
  export BATS_FETCH_COUNT_FILE="$fetch_count_file"
  fetch_parent_comment() {
    FETCH_COUNT=$((FETCH_COUNT + 1))
    echo "$FETCH_COUNT" > "$BATS_FETCH_COUNT_FILE"
    echo '{"id":100,"body":"Parent","user_login":"reviewer1","path":"src/main.ts"}'
  }
  export -f fetch_parent_comment

  local comments='[
    {"id":201,"body":"Reply 1","in_reply_to_id":100},
    {"id":202,"body":"Reply 2","in_reply_to_id":100}
  ]'

  run resolve_thread_context "owner/repo" "$comments"

  [[ $status -eq 0 ]]
  # Both replies should have thread_context
  echo "$output" | jq -e '.[0].thread_context.id == 100'
  echo "$output" | jq -e '.[1].thread_context.id == 100'
  # Parent should have been fetched only once (unique parent IDs)
  local count
  count=$(cat "$fetch_count_file")
  [[ $count -eq 1 ]]
}

@test "resolve_thread_context handles mixed comments with and without replies" {
  fetch_parent_comment() {
    echo '{"id":100,"body":"Parent","user_login":"reviewer1","path":"src/main.ts"}'
  }
  export -f fetch_parent_comment

  local comments='[
    {"id":150,"body":"Standalone","in_reply_to_id":null},
    {"id":200,"body":"Reply","in_reply_to_id":100}
  ]'

  run resolve_thread_context "owner/repo" "$comments"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.[0] | has("thread_context") | not'
  echo "$output" | jq -e '.[1].thread_context.id == 100'
}

# ============================================================================
# unreacted comments tests
# ============================================================================

@test "fetch_unreacted_comments requires at least 3 arguments" {
  run fetch_unreacted_comments "42" "100"

  [[ $status -eq 2 ]]
  [[ $output == *"requires 3 or 4 arguments"* ]]
}

@test "fetch_unreacted_comments validates watermark is numeric" {
  run fetch_unreacted_comments "42" "bad" "agent-bot"

  [[ $status -eq 2 ]]
  [[ $output == *"watermark must be a non-negative integer"* ]]
}

@test "fetch_unreacted_comments returns empty when no candidates" {
  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return 0
    elif [[ $1 == "api" ]]; then
      echo "[]"
      return 0
    fi
  }
  export -f gh

  run fetch_unreacted_comments "42" "100" "agent-bot"

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '. | length == 0'
}

@test "fetch_unreacted_comments filters out comments with terminal agent reactions" {
  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return 0
    elif [[ $1 == "api" ]]; then
      local api_path="$2"
      # Extract --jq arg if present
      local jq_expr=""
      for arg in "$@"; do
        if [[ $arg == "--jq" ]]; then
          local found_jq=true
          continue
        fi
        if [[ ${found_jq:-} == "true" ]]; then
          jq_expr="$arg"
          found_jq=false
        fi
      done

      if [[ $api_path == *"/reactions"* ]]; then
        # Comment 50 has a +1 from agent, comment 60 has no agent reactions
        local raw_data
        if [[ $api_path == *"/50/reactions"* ]]; then
          raw_data='[{"user":{"login":"agent-bot"},"content":"+1"}]'
        else
          raw_data='[]'
        fi
        if [[ -n $jq_expr ]]; then
          echo "$raw_data" | jq -r "$jq_expr"
        else
          echo "$raw_data"
        fi
      else
        # Return two candidate comments below watermark (raw API format)
        local raw_data='[{"id":50,"body":"Fix this","path":"src/a.ts","user":{"login":"reviewer1","type":"User"},"in_reply_to_id":null},{"id":60,"body":"Also fix","path":"src/b.ts","user":{"login":"reviewer1","type":"User"},"in_reply_to_id":null}]'
        if [[ -n $jq_expr ]]; then
          echo "$raw_data" | jq -r "$jq_expr"
        else
          echo "$raw_data"
        fi
      fi
      return 0
    fi
  }
  export -f gh

  run fetch_unreacted_comments "42" "100" "agent-bot"

  [[ $status -eq 0 ]]
  # Only comment 60 should remain (50 has +1 from agent)
  echo "$output" | jq -e '. | length == 1'
  echo "$output" | jq -e '.[0].id == 60'
}

# ============================================================================
# poll --include-unreacted tests
# ============================================================================

@test "cmd_poll accepts --include-unreacted flag" {
  get_pr_info() {
    echo '{"pr_state":"OPEN","pr_author":"testuser","mergeable":"MERGEABLE"}'
  }
  export -f get_pr_info

  get_bk_status() {
    echo '{"bk_state":"success","bk_desc":"passed","bk_url":"https://bk.com/1"}'
  }
  export -f get_bk_status

  fetch_all_reviews() {
    echo '[]'
  }
  export -f fetch_all_reviews

  fetch_new_comments() {
    echo '[]'
  }
  export -f fetch_new_comments

  fetch_new_issue_comments() {
    echo '[]'
  }
  export -f fetch_new_issue_comments

  resolve_thread_context() {
    echo "$2"
  }
  export -f resolve_thread_context

  get_gh_user() {
    echo "agent-bot"
  }
  export -f get_gh_user

  fetch_unreacted_comments() {
    echo '[{"id":50,"body":"old unaddressed","path":"src/a.ts","user_login":"reviewer1","user_type":"User","in_reply_to_id":null}]'
  }
  export -f fetch_unreacted_comments

  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return 0
    fi
  }
  export -f gh

  run cmd_poll 42 abc123 --include-unreacted

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.unreacted_comments | length == 1'
  echo "$output" | jq -e '.unreacted_comments[0].id == 50'
}

@test "cmd_poll omits unreacted_comments when --include-unreacted not set" {
  get_pr_info() {
    echo '{"pr_state":"OPEN","pr_author":"testuser","mergeable":"MERGEABLE"}'
  }
  export -f get_pr_info

  get_bk_status() {
    echo '{"bk_state":"success","bk_desc":"passed","bk_url":"https://bk.com/1"}'
  }
  export -f get_bk_status

  fetch_all_reviews() {
    echo '[]'
  }
  export -f fetch_all_reviews

  fetch_new_comments() {
    echo '[]'
  }
  export -f fetch_new_comments

  fetch_new_issue_comments() {
    echo '[]'
  }
  export -f fetch_new_issue_comments

  resolve_thread_context() {
    echo "$2"
  }
  export -f resolve_thread_context

  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return 0
    fi
  }
  export -f gh

  run cmd_poll 42 abc123

  [[ $status -eq 0 ]]
  echo "$output" | jq -e 'has("unreacted_comments") | not'
}

@test "cmd_poll resolves thread context for comments with in_reply_to_id" {
  get_pr_info() {
    echo '{"pr_state":"OPEN","pr_author":"testuser","mergeable":"MERGEABLE"}'
  }
  export -f get_pr_info

  get_bk_status() {
    echo '{"bk_state":"pending","bk_desc":"running","bk_url":"https://bk.com/1"}'
  }
  export -f get_bk_status

  fetch_all_reviews() {
    echo '[]'
  }
  export -f fetch_all_reviews

  fetch_new_comments() {
    echo '[{"id":200,"body":"Reply text","path":"src/a.ts","user_login":"reviewer1","user_type":"User","in_reply_to_id":100}]'
  }
  export -f fetch_new_comments

  fetch_new_issue_comments() {
    echo '[]'
  }
  export -f fetch_new_issue_comments

  resolve_thread_context() {
    # Simulate adding thread_context
    echo "$2" | jq '[.[] | . + {thread_context: {id: 100, body: "Parent comment", user_login: "copilot", path: "src/a.ts"}}]'
  }
  export -f resolve_thread_context

  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return 0
    fi
  }
  export -f gh

  run cmd_poll 42 abc123

  [[ $status -eq 0 ]]
  echo "$output" | jq -e '.comments[0].thread_context.id == 100'
  echo "$output" | jq -e '.comments[0].thread_context.body == "Parent comment"'
}
