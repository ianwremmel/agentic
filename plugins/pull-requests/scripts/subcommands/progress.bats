#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/progress"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# progress subcommand tests
# ============================================================================

@test "extract_progress extracts YAML from body with progress block" {
  local body="Some PR text
<!-- clc-progress
phase: implementation
ci_fix_attempts: 0
-->
More text"

  run extract_progress "$body"

  [[ $status -eq 0 ]]
  [[ $output == *"phase: implementation"* ]]
  [[ $output == *"ci_fix_attempts: 0"* ]]
}

@test "extract_progress returns empty for body without progress block" {
  local body="Some PR text without any progress block"

  run extract_progress "$body"

  [[ $status -eq 0 ]]
  [[ -z $output ]]
}

@test "read_progress calls get_pr_body and extracts progress" {
  gh() {
    echo "PR body here
<!-- clc-progress
phase: ci_monitoring
-->
end"
  }
  export -f gh

  run read_progress "42"

  [[ $status -eq 0 ]]
  [[ $output == *"phase: ci_monitoring"* ]]
}

@test "write_progress requires pr_number and field=value" {
  run write_progress "42"

  [[ $status -eq 2 ]]
  [[ $output == *"requires pr_number and at least one field=value"* ]]
}

@test "write_progress rejects invalid field=value pair" {
  run write_progress "42" "not-a-valid-key=value"

  [[ $status -eq 2 ]]
  [[ $output == *"invalid field=value pair"* ]]
}

@test "write_progress rejects pair without equals sign" {
  run write_progress "42" "justtext"

  [[ $status -eq 2 ]]
  [[ $output == *"invalid field=value pair"* ]]
}

@test "write_progress updates existing field" {
  MOCK_PR_BODY="Some text
<!-- clc-progress
phase: implementation
ci_fix_attempts: 0
-->
End"
  export MOCK_PR_BODY
  CAPTURED_FILE="${BATS_TMPDIR}/captured_body_write_update"
  export CAPTURED_FILE

  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo "$MOCK_PR_BODY"
    elif [[ $1 == "pr" && $2 == "edit" ]]; then
      # args: pr edit <number> --body-file <path>
      cat "$5" > "$CAPTURED_FILE"
    fi
  }
  export -f gh

  run write_progress "42" "phase=ci_monitoring"

  [[ $status -eq 0 ]]
  local captured
  captured=$(cat "$CAPTURED_FILE")
  [[ $captured == *"phase: ci_monitoring"* ]]
  [[ $captured == *"last_updated:"* ]]
  rm -f "$CAPTURED_FILE"
}

@test "write_progress appends new progress block when none exists" {
  MOCK_PR_BODY="A PR body with no progress block"
  export MOCK_PR_BODY
  CAPTURED_FILE=$(mktemp)
  export CAPTURED_FILE

  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo "$MOCK_PR_BODY"
    elif [[ $1 == "pr" && $2 == "edit" ]]; then
      # args: pr edit <number> --body-file <path>
      cat "$5" > "$CAPTURED_FILE"
    fi
  }
  export -f gh

  run write_progress "42" "phase=implementation"

  [[ $status -eq 0 ]]
  local captured
  captured=$(cat "$CAPTURED_FILE")
  [[ $captured == *"<!-- clc-progress"* ]]
  [[ $captured == *"phase: implementation"* ]]
  [[ $captured == *"last_updated:"* ]]
  [[ $captured == *"-->"* ]]
  rm -f "$CAPTURED_FILE"
}

@test "update_checklist requires 3 arguments" {
  run update_checklist "42" "item"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 3 arguments"* ]]
}

@test "update_checklist checks an unchecked item" {
  MOCK_PR_BODY="## Progress
- [ ] Code review
- [ ] CI passing
- [x] Tests written"
  export MOCK_PR_BODY
  CAPTURED_FILE=$(mktemp)
  export CAPTURED_FILE

  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo "$MOCK_PR_BODY"
    elif [[ $1 == "pr" && $2 == "edit" ]]; then
      # args: pr edit <number> --body-file <path>
      cat "$5" > "$CAPTURED_FILE"
    fi
  }
  export -f gh

  run update_checklist "42" "CI passing" "checked"

  [[ $status -eq 0 ]]
  local captured
  captured=$(cat "$CAPTURED_FILE")
  [[ $captured == *"- [x] CI passing"* ]]
  # Other items should remain unchanged
  [[ $captured == *"- [ ] Code review"* ]]
  [[ $captured == *"- [x] Tests written"* ]]
  rm -f "$CAPTURED_FILE"
}

@test "update_checklist unchecks a checked item" {
  MOCK_PR_BODY="## Progress
- [x] Code review
- [x] CI passing"
  export MOCK_PR_BODY
  CAPTURED_FILE=$(mktemp)
  export CAPTURED_FILE

  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo "$MOCK_PR_BODY"
    elif [[ $1 == "pr" && $2 == "edit" ]]; then
      # args: pr edit <number> --body-file <path>
      cat "$5" > "$CAPTURED_FILE"
    fi
  }
  export -f gh

  run update_checklist "42" "Code review" "unchecked"

  [[ $status -eq 0 ]]
  local captured
  captured=$(cat "$CAPTURED_FILE")
  [[ $captured == *"- [ ] Code review"* ]]
  [[ $captured == *"- [x] CI passing"* ]]
  rm -f "$CAPTURED_FILE"
}

@test "cmd_progress requires at least 2 arguments" {
  run cmd_progress "read"

  [[ $status -eq 1 ]]
  [[ $output == *"requires at least 2 arguments"* ]]
}

@test "cmd_progress dispatches to read" {
  gh() {
    echo "body
<!-- clc-progress
phase: done
-->
end"
  }
  export -f gh

  run cmd_progress read "42"

  [[ $status -eq 0 ]]
  [[ $output == *"phase: done"* ]]
}

@test "cmd_progress dispatches to write" {
  MOCK_PR_BODY="body
<!-- clc-progress
phase: impl
-->
end"
  export MOCK_PR_BODY

  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo "$MOCK_PR_BODY"
    elif [[ $1 == "pr" && $2 == "edit" ]]; then
      echo "edited"
    fi
  }
  export -f gh

  run cmd_progress write "42" "phase=done"

  [[ $status -eq 0 ]]
}

@test "cmd_progress dispatches to checklist" {
  MOCK_PR_BODY="- [ ] item one"
  export MOCK_PR_BODY

  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo "$MOCK_PR_BODY"
    elif [[ $1 == "pr" && $2 == "edit" ]]; then
      echo "edited"
    fi
  }
  export -f gh

  run cmd_progress checklist "42" "item one" "checked"

  [[ $status -eq 0 ]]
}

@test "cmd_progress rejects unknown command" {
  run cmd_progress foobar "42"

  [[ $status -eq 1 ]]
  [[ $output == *"unknown command"* ]]
}
