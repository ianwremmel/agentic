# subcommands/react - Apply emoji reactions to inline review comments or issue comments.
# Sourced by ../orchestrate; defines functions for the `react` subcommand.

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"

# Applies an emoji reaction to a comment via GitHub API
# Arguments:
#   $1 - comment_id
#   $2 - reaction: +1, -1, eyes, rocket, confused, hooray
#   --type inline|issue
# Returns:
#   0 on success
cmd_react() {
  if [[ $# -lt 3 ]]; then
    echo "Error: requires at least 3 arguments" >&2
    echo "Usage: scripts/orchestrate react <comment_id> <reaction> --type inline|issue" >&2
    return 1
  fi

  local comment_id="$1"
  local reaction="$2"
  shift 2

  local comment_type=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      --type)
        if [[ $# -lt 2 ]]; then
          echo "Error: --type requires a value" >&2
          return 1
        fi
        comment_type="$2"
        shift 2
        ;;
      *)
        echo "Error: unknown option '$1'" >&2
        return 1
        ;;
    esac
  done

  if [[ -z $comment_type ]]; then
    echo "Error: --type is required" >&2
    return 1
  fi

  if [[ $comment_type != "inline" && $comment_type != "issue" ]]; then
    echo "Error: --type must be 'inline' or 'issue', got '$comment_type'" >&2
    return 1
  fi

  # Validate reaction
  case $reaction in
    +1|-1|eyes|rocket|confused|hooray|laugh|heart) ;;
    *)
      echo "Error: unsupported reaction '${reaction}'" >&2
      return 1
      ;;
  esac

  local repo
  repo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')

  local api_path
  if [[ $comment_type == "inline" ]]; then
    api_path="repos/${repo}/pulls/comments/${comment_id}/reactions"
  else
    api_path="repos/${repo}/issues/comments/${comment_id}/reactions"
  fi

  retry 3 5 gh api "$api_path" -f "content=${reaction}" --silent
}
