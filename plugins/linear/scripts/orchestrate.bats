#!/usr/bin/env bats

setup() {
  source "./scripts/orchestrate"

  # Mock retry after sourcing so it overrides the real _retry implementation
  retry() {
    shift 2
    "$@"
  }
  export -f retry

  # Helper: mock gh that extracts --jq and applies it with real jq
  # Tests define _gh_raw_data() to return raw JSON based on arguments
  _apply_jq_from_args() {
    local jq_expr=""
    local data
    local i=1
    while [[ $i -le $# ]]; do
      if [[ ${!i} == "--jq" ]]; then
        local next=$((i + 1))
        jq_expr="${!next}"
      fi
      i=$((i + 1))
    done

    data=$(_gh_raw_data "$@")
    if [[ -n $jq_expr ]]; then
      echo "$data" | jq -r "$jq_expr"
    else
      echo "$data"
    fi
  }
  export -f _apply_jq_from_args

  # Isolate review tests from environment
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
}

# ============================================================================
# Script structure tests
# ============================================================================

@test "orchestrate script exists and is executable" {
  [[ -x "./scripts/orchestrate" ]]
}

@test "orchestrate uses set -euo pipefail" {
  run grep -q 'set -euo pipefail' ./scripts/orchestrate

  [[ $status -eq 0 ]]
}

# ============================================================================
# Top-level dispatch tests
# ============================================================================

@test "main requires a subcommand" {
  run main

  [[ $status -eq 1 ]]
  [[ $output == *"subcommand required"* ]]
}

@test "main rejects unknown subcommand" {
  run main foobar

  [[ $status -eq 1 ]]
  [[ $output == *"unknown subcommand"* ]]
}

# ============================================================================
# ready subcommand tests
# ============================================================================

@test "mark_ready requires exactly 1 argument" {
  run mark_ready

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "mark_ready rejects too many arguments" {
  run mark_ready "42" "extra"

  [[ $status -eq 2 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "mark_ready calls gh pr ready" {
  gh() {
    echo "gh-args: $*"
  }
  export -f gh

  run mark_ready "42"

  [[ $status -eq 0 ]]
  [[ $output == *"pr ready 42"* ]]
}

@test "cmd_ready requires exactly 1 argument" {
  run cmd_ready

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_ready rejects too many arguments" {
  run cmd_ready "42" "extra"

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_ready outputs success message" {
  gh() {
    echo "gh-args: $*"
  }
  export -f gh

  run cmd_ready "42"

  [[ $status -eq 0 ]]
  [[ $output == *"PR #42 marked as ready for review"* ]]
}

# ============================================================================
# reply subcommand tests
# ============================================================================

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

# ============================================================================
# setup subcommand tests
# ============================================================================

@test "cmd_setup requires at least 1 argument" {
  run cmd_setup

  [[ $status -eq 1 ]]
  [[ $output == *"requires at least 1 argument"* ]]
}

@test "cmd_setup fails for non-existent directory" {
  run cmd_setup "/nonexistent/path"

  [[ $status -eq 1 ]]
  [[ $output == *"directory does not exist"* ]]
}

@test "cmd_setup with --abort when no rebase in progress outputs JSON to stdout" {
  local tmpdir
  tmpdir=$(mktemp -d)
  mkdir -p "${tmpdir}/.git"

  run cmd_setup "$tmpdir" --abort

  [[ $status -eq 0 ]]
  [[ $output == *"no_rebase_in_progress"* ]]
  rm -rf "$tmpdir"
}

@test "cmd_setup aborts stale rebase state before rebasing" {
  local tmpdir
  tmpdir=$(mktemp -d)
  mkdir -p "${tmpdir}/.git/rebase-merge"

  git() {
    if [[ $3 == "rebase" && $4 == "--abort" ]]; then
      rm -rf "${tmpdir}/.git/rebase-merge"
      return 0
    elif [[ $3 == "fetch" ]]; then
      return 0
    elif [[ $3 == "rebase" && $4 == "origin/main" ]]; then
      return 0
    fi
  }
  export -f git

  run cmd_setup "$tmpdir"

  [[ $status -eq 0 ]]
  [[ $output == *"ok"* ]]
  rm -rf "$tmpdir"
}

@test "cmd_setup succeeds on clean rebase" {
  local tmpdir
  tmpdir=$(mktemp -d)
  mkdir -p "${tmpdir}/.git"

  git() {
    if [[ $3 == "fetch" ]]; then
      return 0
    elif [[ $3 == "rebase" ]]; then
      echo "Successfully rebased"
      return 0
    fi
  }
  export -f git

  run cmd_setup "$tmpdir"

  [[ $status -eq 0 ]]
  [[ $output == *"ok"* ]]
  rm -rf "$tmpdir"
}

@test "cmd_setup exits 2 on rebase conflict with JSON output" {
  local tmpdir
  tmpdir=$(mktemp -d)
  mkdir -p "${tmpdir}/.git"

  git() {
    if [[ $3 == "fetch" ]]; then
      return 0
    elif [[ $3 == "rebase" && $4 == "origin/main" ]]; then
      echo "CONFLICT (content): Merge conflict in file.txt" >&2
      return 1
    elif [[ $3 == "diff" ]]; then
      echo "file.txt"
      echo "other.ts"
      return 0
    fi
  }
  export -f git

  run cmd_setup "$tmpdir"

  [[ $status -eq 2 ]]
  [[ $output == *'"status":"conflict"'* ]]
  [[ $output == *'"file.txt"'* ]]
  [[ $output == *'"other.ts"'* ]]
  rm -rf "$tmpdir"
}

# ============================================================================
# find-worktree subcommand tests
# ============================================================================

@test "cmd_find_worktree requires exactly 1 argument" {
  run cmd_find_worktree

  [[ $status -eq 1 ]]
  [[ $output == *"requires exactly 1 argument"* ]]
}

@test "cmd_find_worktree returns not-found for unknown PR number" {
  gh() {
    return 1
  }
  export -f gh

  run cmd_find_worktree "99999"

  [[ $status -eq 0 ]]
  [[ $output == *'"found":false'* ]]
  [[ $output == *'"created":false'* ]]
}

@test "cmd_find_worktree detects PR number identifier" {
  gh() {
    if [[ $1 == "pr" && $2 == "view" ]]; then
      echo "feature/my-branch"
      return 0
    fi
  }
  export -f gh

  git() {
    if [[ $1 == "worktree" ]]; then
      echo ""
      return 0
    elif [[ $1 == "ls-remote" ]]; then
      return 1
    fi
  }
  export -f git

  run cmd_find_worktree "123"

  [[ $status -eq 0 ]]
  [[ $output == *'"branch_name":"feature/my-branch"'* ]]
  [[ $output == *'"found":false'* ]]
  [[ $output == *'"created":false'* ]]
}

@test "cmd_find_worktree detects ticket ID identifier" {
  git() {
    if [[ $1 == "worktree" ]]; then
      printf 'worktree /home/user/worktrees/apps/clc-100-feat\nbranch refs/heads/ianwremmel/clc-100-feat\n'
      return 0
    fi
  }
  export -f git

  run cmd_find_worktree "CLC-100"

  [[ $status -eq 0 ]]
  [[ $output == *'"found":true'* ]]
  [[ $output == *'"branch_name":"ianwremmel/clc-100-feat"'* ]]
}

@test "cmd_find_worktree returns not-found for unknown ticket ID" {
  git() {
    if [[ $1 == "worktree" ]]; then
      echo ""
      return 0
    elif [[ $1 == "branch" ]]; then
      echo ""
      return 0
    fi
  }
  export -f git

  run cmd_find_worktree "CLC-999"

  [[ $status -eq 0 ]]
  [[ $output == *'"found":false'* ]]
  [[ $output == *'"created":false'* ]]
}

@test "cmd_find_worktree sanitizes slashes in branch names for directory paths" {
  git() {
    if [[ $1 == "worktree" ]]; then
      echo ""
      return 0
    elif [[ $1 == "ls-remote" ]]; then
      return 1
    fi
  }
  export -f git

  run cmd_find_worktree "feature/my-branch"

  [[ $status -eq 0 ]]
  # The worktree_dir should use _ instead of / in the directory name
  [[ $output == *"feature_my-branch"* ]]
  # The branch_name should preserve the original slash
  [[ $output == *'feature/my-branch'* ]]
}

# ============================================================================
# react subcommand tests
# ============================================================================

@test "cmd_react requires at least 3 arguments" {
  run cmd_react "123" "eyes"

  [[ $status -eq 1 ]]
  [[ $output == *"requires at least 3 arguments"* ]]
}

@test "cmd_react requires --type flag" {
  run cmd_react "123" "eyes" "--unknown" "inline"

  [[ $status -eq 1 ]]
  [[ $output == *"unknown option"* ]]
}

@test "cmd_react rejects invalid type" {
  run cmd_react "123" "eyes" --type "invalid"

  [[ $status -eq 1 ]]
  [[ $output == *"must be 'inline' or 'issue'"* ]]
}

@test "cmd_react rejects unsupported reaction" {
  run cmd_react "123" "invalid_emoji" --type "inline"

  [[ $status -eq 1 ]]
  [[ $output == *"unsupported reaction"* ]]
}

@test "cmd_react calls correct API for inline comments" {
  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return 0
    elif [[ $1 == "api" ]]; then
      echo "API_PATH=$2"
      return 0
    fi
  }
  export -f gh

  run cmd_react "456" "+1" --type "inline"

  [[ $status -eq 0 ]]
  [[ $output == *"repos/owner/repo/pulls/comments/456/reactions"* ]]
}

@test "cmd_react calls correct API for issue comments" {
  gh() {
    if [[ $1 == "repo" ]]; then
      echo "owner/repo"
      return 0
    elif [[ $1 == "api" ]]; then
      echo "API_PATH=$2"
      return 0
    fi
  }
  export -f gh

  run cmd_react "789" "eyes" --type "issue"

  [[ $status -eq 0 ]]
  [[ $output == *"repos/owner/repo/issues/comments/789/reactions"* ]]
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

# ============================================================================
# dispatch tests for new subcommands
# ============================================================================

@test "main dispatches to setup" {
  cmd_setup() {
    echo "setup called with: $*"
  }
  export -f cmd_setup

  run main setup "/tmp/test"

  [[ $status -eq 0 ]]
  [[ $output == *"setup called with: /tmp/test"* ]]
}

@test "main dispatches to find-worktree" {
  cmd_find_worktree() {
    echo "find-worktree called with: $*"
  }
  export -f cmd_find_worktree

  run main find-worktree "CLC-100"

  [[ $status -eq 0 ]]
  [[ $output == *"find-worktree called with: CLC-100"* ]]
}

@test "main dispatches to react" {
  cmd_react() {
    echo "react called with: $*"
  }
  export -f cmd_react

  run main react "123" "eyes" --type "inline"

  [[ $status -eq 0 ]]
  [[ $output == *"react called with: 123 eyes --type inline"* ]]
}

@test "main dispatches to label" {
  cmd_label() {
    echo "label called with: $*"
  }
  export -f cmd_label

  run main label add "42" "agent-working"

  [[ $status -eq 0 ]]
  [[ $output == *"label called with: add 42 agent-working"* ]]
}

@test "main dispatches to start-pr" {
  cmd_start_pr() {
    echo "start-pr called with: $*"
  }
  export -f cmd_start_pr

  run main start-pr "/tmp/test" --ticket-id "CLC-100"

  [[ $status -eq 0 ]]
  [[ $output == *"start-pr called with: /tmp/test --ticket-id CLC-100"* ]]
}

@test "main dispatches to poll" {
  cmd_poll() {
    echo "poll called with: $*"
  }
  export -f cmd_poll

  run main poll "42" "abc123"

  [[ $status -eq 0 ]]
  [[ $output == *"poll called with: 42 abc123"* ]]
}

@test "main dispatches to review" {
  cmd_review() {
    echo "review called with: $*"
  }
  export -f cmd_review

  run main review copilot "42"

  [[ $status -eq 0 ]]
  [[ $output == *"review called with: copilot 42"* ]]
}

@test "main dispatches to check-status" {
  cmd_check_status() {
    echo "check-status called with: $*"
  }
  export -f cmd_check_status

  run main check-status "42"

  [[ $status -eq 0 ]]
  [[ $output == *"check-status called with: 42"* ]]
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

# ============================================================================
# debug subcommand tests
# ============================================================================

@test "main dispatches to debug" {
  cmd_debug() {
    echo "debug called with: $*"
  }
  export -f cmd_debug

  run main debug "42"

  [[ $status -eq 0 ]]
  [[ $output == *"debug called with: 42"* ]]
}

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
