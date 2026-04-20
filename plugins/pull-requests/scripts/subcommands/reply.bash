# subcommands/reply - Post agent-authored replies (inline review replies and PR-level comments). Wraps bodies in a sparkle block when the agent is authenticated as a human.
# Sourced by ../orchestrate; defines functions for the `reply` subcommand.

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"
source "$SCRIPTS_DIR/lib/gh-auth.bash"

# Replies to an inline review comment
# Arguments:
#   $1 - pr_number
#   $2 - comment_id: The review comment ID to reply to
#   $3 - body: Reply body text
# Returns:
#   0 on success
reply_inline() {
  if [[ $# -ne 3 ]]; then
    echo "Error: reply_inline requires exactly 3 arguments" >&2
    echo "Usage: reply_inline <pr_number> <comment_id> <body>" >&2
    return 2
  fi

  local pr_number="$1"
  local comment_id="$2"
  local body
  body=$(wrap_agent_body "$3")
  local repo
  repo=$(retry 3 5 gh repo view --json nameWithOwner --jq '.nameWithOwner')

  retry 3 5 gh api "repos/${repo}/pulls/${pr_number}/comments/${comment_id}/replies" \
    -f "body=${body}" \
    --silent
}

# Posts an issue comment on the PR
# Arguments:
#   $1 - pr_number
#   $2 - body: Comment body text
# Returns:
#   0 on success
reply_issue() {
  if [[ $# -ne 2 ]]; then
    echo "Error: reply_issue requires exactly 2 arguments" >&2
    echo "Usage: reply_issue <pr_number> <body>" >&2
    return 2
  fi

  local pr_number="$1"
  local body
  body=$(wrap_agent_body "$2")

  retry 3 5 gh pr comment "$pr_number" --body "$body"
}

# reply subcommand main
cmd_reply() {
  if [[ $# -lt 1 ]]; then
    echo "Error: requires at least 1 argument" >&2
    echo "Usage: scripts/orchestrate reply --inline <pr_number> <comment_id> <body>" >&2
    echo "       scripts/orchestrate reply --issue <pr_number> <body>" >&2
    return 1
  fi

  local mode="$1"
  shift

  case $mode in
    --inline)
      if [[ $# -ne 3 ]]; then
        echo "Error: --inline requires 3 arguments" >&2
        echo "Usage: scripts/orchestrate reply --inline <pr_number> <comment_id> <body>" >&2
        return 1
      fi
      reply_inline "$@"
      ;;
    --issue)
      if [[ $# -ne 2 ]]; then
        echo "Error: --issue requires 2 arguments" >&2
        echo "Usage: scripts/orchestrate reply --issue <pr_number> <body>" >&2
        return 1
      fi
      reply_issue "$@"
      ;;
    *)
      echo "Error: unknown mode '${mode}', expected --inline or --issue" >&2
      return 1
      ;;
  esac
}
