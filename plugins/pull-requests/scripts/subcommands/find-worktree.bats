#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/find-worktree"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
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
