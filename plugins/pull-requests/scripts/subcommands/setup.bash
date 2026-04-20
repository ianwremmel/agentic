# subcommands/setup - Prepare a worktree by fetching origin/main and rebasing.
# Sourced by ../orchestrate; defines functions for the `setup` subcommand.

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"

# Prepares a worktree by fetching origin/main and rebasing
# Arguments:
#   $1 - worktree_dir: Path to the worktree
#   $2 - (optional) --abort: Abort an in-progress rebase instead
# Returns:
#   Exit 0 on success
#   Exit 2 on rebase conflict with JSON output
cmd_setup() {
  if [[ $# -lt 1 ]]; then
    echo "Error: requires at least 1 argument" >&2
    echo "Usage: scripts/orchestrate setup <worktree_dir> [--abort]" >&2
    return 1
  fi

  local worktree_dir="$1"
  shift

  if [[ ! -d $worktree_dir ]]; then
    echo "Error: directory does not exist: $worktree_dir" >&2
    return 1
  fi

  # Handle --abort flag
  if [[ ${1:-} == "--abort" ]]; then
    if [[ -d "${worktree_dir}/.git/rebase-merge" ]] || [[ -d "${worktree_dir}/.git/rebase-apply" ]]; then
      git -C "$worktree_dir" rebase --abort >&2
      echo '{"status":"aborted"}'
    else
      echo '{"status":"no_rebase_in_progress"}'
    fi
    return 0
  fi

  # Abort stale mid-rebase state if present
  if [[ -d "${worktree_dir}/.git/rebase-merge" ]] || [[ -d "${worktree_dir}/.git/rebase-apply" ]]; then
    echo "Aborting stale rebase state..." >&2
    git -C "$worktree_dir" rebase --abort >&2
  fi

  # Fetch latest main
  git -C "$worktree_dir" fetch origin main >&2

  # Attempt rebase with explicit error trapping (not relying on set -e)
  local rebase_output
  local rebase_exit=0
  rebase_output=$(git -C "$worktree_dir" rebase origin/main 2>&1) || rebase_exit=$?

  if [[ $rebase_exit -eq 0 ]]; then
    echo '{"status":"ok"}'
    return 0
  fi

  # Rebase failed -- check for conflicts
  local conflict_files
  conflict_files=$(git -C "$worktree_dir" diff --name-only --diff-filter=U 2>/dev/null)

  if [[ -n $conflict_files ]]; then
    # Build JSON safely using jq to handle special characters in file paths
    local files_json
    files_json=$(printf '%s\n' "$conflict_files" | jq -R . | jq -s '.')

    jq -cn --argjson files "$files_json" '{"status":"conflict","files":$files}'
    return 2
  fi

  # Non-conflict rebase failure
  echo "Error: rebase failed: ${rebase_output}" >&2
  return 1
}
