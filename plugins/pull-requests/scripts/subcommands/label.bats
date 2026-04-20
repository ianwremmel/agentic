#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/label.bash"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# label subcommand tests
# ============================================================================

@test "cmd_label requires exactly 3 arguments" {
  run cmd_label "add" "42"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 3 arguments"* ]]
}

@test "cmd_label rejects invalid action" {
  run cmd_label "invalid" "42" "my-label"

  [[ $status -eq 1 ]]
  [[ $output == *"must be 'add' or 'remove'"* ]]
}

@test "cmd_label add succeeds on first attempt" {
  gh() {
    if [[ $1 == "pr" && $2 == "edit" ]]; then
      return 0
    fi
  }
  export -f gh

  run cmd_label add "42" "agent-working"

  [[ $status -eq 0 ]]
}

@test "cmd_label add creates label on 404 and retries" {
  CALL_COUNT=0
  export CALL_COUNT

  gh() {
    if [[ $1 == "pr" && $2 == "edit" ]]; then
      CALL_COUNT=$((CALL_COUNT + 1))
      if [[ $CALL_COUNT -eq 1 ]]; then
        echo "label not found" >&2
        return 1
      fi
      return 0
    elif [[ $1 == "label" && $2 == "create" ]]; then
      return 0
    fi
  }
  export -f gh

  run cmd_label add "42" "agent-working"

  [[ $status -eq 0 ]]
}

@test "cmd_label add does not block on complete failure" {
  gh() {
    if [[ $1 == "pr" && $2 == "edit" ]]; then
      echo "not found" >&2
      return 1
    elif [[ $1 == "label" && $2 == "create" ]]; then
      return 1
    fi
  }
  export -f gh

  run cmd_label add "42" "unknown-label"

  [[ $status -eq 0 ]]
  [[ $output == *"Warning"* ]]
}

@test "cmd_label add succeeds when label already exists on PR" {
  gh() {
    if [[ $1 == "pr" && $2 == "edit" ]]; then
      # gh pr edit --add-label succeeds even when label is already applied
      return 0
    fi
  }
  export -f gh

  run cmd_label add "42" "agent-working"

  [[ $status -eq 0 ]]
  # No warning output -- the command succeeds silently
  [[ -z $output ]]
}

@test "cmd_label add retries after create but retry also fails" {
  local call_log
  call_log=$(mktemp)
  export LABEL_CALL_LOG="$call_log"

  gh() {
    if [[ $1 == "pr" && $2 == "edit" ]]; then
      echo "pr-edit" >>"$LABEL_CALL_LOG"
      echo "label not found" >&2
      return 1
    elif [[ $1 == "label" && $2 == "create" ]]; then
      echo "label-create" >>"$LABEL_CALL_LOG"
      # Label creation succeeds but the retry add still fails
      return 0
    fi
  }
  export -f gh

  run cmd_label add "42" "agent-working"

  [[ $status -eq 0 ]]
  [[ $output == *"Warning"* ]]
  # Verify: initial add attempt + retry after create = 2 pr-edit calls
  local pr_edit_count
  pr_edit_count=$(grep -c "pr-edit" "$call_log" || true)
  [[ $pr_edit_count -eq 2 ]]
  # Verify: label create was called exactly once
  local label_create_count
  label_create_count=$(grep -c "label-create" "$call_log" || true)
  [[ $label_create_count -eq 1 ]]
  rm -f "$call_log"
}

@test "cmd_label remove succeeds" {
  gh() {
    if [[ $1 == "pr" && $2 == "edit" ]]; then
      return 0
    fi
  }
  export -f gh

  run cmd_label remove "42" "agent-working"

  [[ $status -eq 0 ]]
}

@test "cmd_label remove does not block on failure" {
  gh() {
    return 1
  }
  export -f gh

  run cmd_label remove "42" "agent-working"

  [[ $status -eq 0 ]]
  [[ $output == *"Warning"* ]]
}
