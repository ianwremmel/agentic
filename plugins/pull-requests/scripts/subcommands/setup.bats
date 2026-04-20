#!/usr/bin/env bats

setup() {
  source "./scripts/subcommands/setup.bash"
  source "./scripts/test-helpers.bash"
  unset GH_TOKEN
  unset GH_REVIEW_REQUEST_TOKEN
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
