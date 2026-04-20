# subcommands/label - Add or remove labels on a PR, with auto-creation of the agent-working / needs-followup labels.
# Sourced by ../orchestrate; defines functions for the `label` subcommand.

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"

# Predefined label colors and descriptions
label_color() {
  case $1 in
    agent-working) echo "1d76db" ;;
    needs-followup) echo "e4e669" ;;
    *) echo "ededed" ;;
  esac
}


label_description() {
  case $1 in
    agent-working) echo "Agent is actively working on this PR" ;;
    needs-followup) echo "PR has deferred work requiring post-merge review" ;;
    *) echo "" ;;
  esac
}

# Adds or removes a label on a PR with auto-creation on 404
# Arguments:
#   $1 - action: add|remove
#   $2 - pr_number
#   $3 - label_name
# Returns:
#   0 on success (label ops are non-blocking -- warnings on failure)
cmd_label() {
  if [[ $# -ne 3 ]]; then
    echo "Error: requires exactly 3 arguments" >&2
    echo "Usage: scripts/orchestrate label add|remove <pr_number> <label>" >&2
    return 1
  fi

  local action="$1"
  local pr_number="$2"
  local label_name="$3"

  if [[ $action != "add" && $action != "remove" ]]; then
    echo "Error: action must be 'add' or 'remove', got '$action'" >&2
    return 1
  fi

  if [[ $action == "add" ]]; then
    local add_stderr
    add_stderr=$(mktemp)
    if gh pr edit "$pr_number" --add-label "$label_name" 2>"$add_stderr"; then
      rm -f "$add_stderr"
      return 0
    fi

    local stderr_content
    stderr_content=$(cat "$add_stderr")
    rm -f "$add_stderr"

    # Check if label not found (needs creation)
    if [[ $stderr_content == *"not found"* ]] || [[ $stderr_content == *"404"* ]]; then
      local color
      color=$(label_color "$label_name")
      local description
      description=$(label_description "$label_name")

      if gh label create "$label_name" --color "$color" --description "$description" 2>/dev/null; then
        # Retry the add
        if gh pr edit "$pr_number" --add-label "$label_name" 2>/dev/null; then
          return 0
        fi
      fi
    fi

    # Non-blocking failure
    echo "Warning: failed to add label '${label_name}' to PR #${pr_number}" >&2
    return 0
  fi

  # Remove
  if ! gh pr edit "$pr_number" --remove-label "$label_name" 2>/dev/null; then
    echo "Warning: failed to remove label '${label_name}' from PR #${pr_number}" >&2
  fi
  return 0
}
