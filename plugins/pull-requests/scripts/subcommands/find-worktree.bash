# subcommands/find-worktree - Auto-detect identifier type (PR number, ticket ID, branch name) and find or create a worktree.
# Sourced by ../orchestrate; defines functions for the `find-worktree` subcommand.

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"

WORKTREE_BASE="${WORKTREE_BASE:-${HOME}/projects/worktrees/apps}"

# Auto-detects identifier type and finds or creates a worktree
# Arguments:
#   $1 - identifier: PR number, ticket ID, or branch name
# Returns:
#   JSON: {worktree_dir, branch_name, found, created}
cmd_find_worktree() {
  if [[ $# -ne 1 ]]; then
    echo "Error: requires exactly 1 argument" >&2
    echo "Usage: scripts/orchestrate find-worktree <identifier>" >&2
    return 1
  fi

  local identifier="$1"
  local branch_name=""

  # Auto-detect identifier type
  if [[ $identifier =~ ^[0-9]+$ ]]; then
    # PR number -- look up branch via gh
    branch_name=$(gh pr view "$identifier" --json headRefName --jq '.headRefName' 2>/dev/null) || {
      echo '{"worktree_dir":"","branch_name":"","found":false,"created":false}'
      return 0
    }
  elif [[ $identifier =~ ^[A-Z]+-[0-9]+$ ]]; then
    # Ticket ID -- search worktree list for matching branch
    local worktree_list
    worktree_list=$(git worktree list --porcelain 2>/dev/null)
    branch_name=$(printf '%s\n' "$worktree_list" \
      | grep "^branch " \
      | sed 's|^branch refs/heads/||' \
      | grep -i "$identifier" \
      | head -n 1)

    if [[ -z $branch_name ]]; then
      # Check remote branches
      branch_name=$(git branch -r \
        | sed 's|^ *origin/||' \
        | grep -i "$identifier" \
        | head -n 1 \
        | tr -d ' ')
    fi

    if [[ -z $branch_name ]]; then
      echo '{"worktree_dir":"","branch_name":"","found":false,"created":false}'
      return 0
    fi
  else
    # Treat as branch name
    branch_name="$identifier"
  fi

  # Sanitize branch name for directory path (replace / with _)
  local dir_name="${branch_name//\//_}"
  local worktree_dir="${WORKTREE_BASE}/${dir_name}"

  # Check if worktree already exists
  local worktree_list
  worktree_list=$(git worktree list --porcelain 2>/dev/null)
  if printf '%s\n' "$worktree_list" | grep -q "^branch refs/heads/${branch_name}$"; then
    # Found existing worktree -- get its path
    local existing_path
    existing_path=$(printf '%s\n' "$worktree_list" \
      | awk -v branch="branch refs/heads/${branch_name}" '
        /^worktree / { path = substr($0, 10) }
        $0 == branch { print path; exit }
      ')
    if [[ -n $existing_path ]]; then
      worktree_dir="$existing_path"
    fi
    jq -cn --arg dir "$worktree_dir" --arg branch "$branch_name" \
      '{"worktree_dir":$dir,"branch_name":$branch,"found":true,"created":false}'
    return 0
  fi

  # Check if remote branch exists
  if git ls-remote --exit-code --heads origin "$branch_name" >/dev/null 2>&1; then
    # Create worktree from remote branch
    mkdir -p "$WORKTREE_BASE"
    git fetch origin "$branch_name" >&2
    git worktree add "$worktree_dir" "origin/${branch_name}" >&2
    # Create local tracking branch
    git -C "$worktree_dir" checkout -B "$branch_name" "origin/${branch_name}" >&2
    jq -cn --arg dir "$worktree_dir" --arg branch "$branch_name" \
      '{"worktree_dir":$dir,"branch_name":$branch,"found":false,"created":true}'
    return 0
  fi

  # Neither local nor remote -- return the would-be path for reference
  jq -cn --arg dir "$worktree_dir" --arg branch "$branch_name" \
    '{"worktree_dir":$dir,"branch_name":$branch,"found":false,"created":false}'
  return 0
}
