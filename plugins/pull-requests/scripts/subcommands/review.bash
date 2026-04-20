# subcommands/review - Request Copilot or human reviews, with auth-aware token rotation.
# Sourced by ../orchestrate; defines functions for the `review` subcommand.

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"
source "$SCRIPTS_DIR/lib/gh-auth.bash"
source "$SCRIPTS_DIR/lib/reviews.bash"

# review copilot subcommand main
cmd_review_copilot() {
  local force=false

  if [[ $# -ge 1 ]] && [[ $1 == "--force" ]]; then
    force=true
    shift
  fi

  if [[ $# -ne 1 ]]; then
    echo "Error: requires exactly 1 argument" >&2
    echo "Usage: scripts/orchestrate review copilot [--force] <pr_number>" >&2
    return 1
  fi

  local pr_number="$1"
  local current_user

  if current_user=$(get_gh_user); then
    if [[ $current_user == "ianwremmel" ]]; then
      echo "Authenticated as ianwremmel, using existing credentials" >&2
    else
      if [[ -z ${GH_REVIEW_REQUEST_TOKEN:-} ]]; then
        echo "Error: GH_REVIEW_REQUEST_TOKEN must be set when not authenticated as ianwremmel (current user: ${current_user})" >&2
        return 1
      fi
      export GH_TOKEN="${GH_REVIEW_REQUEST_TOKEN}"
    fi
  else
    if [[ -z ${GH_REVIEW_REQUEST_TOKEN:-} ]]; then
      echo "Error: not authenticated with gh and GH_REVIEW_REQUEST_TOKEN is not set" >&2
      return 1
    fi
    export GH_TOKEN="${GH_REVIEW_REQUEST_TOKEN}"
  fi

  if [[ $force == false ]] && has_copilot_review "$pr_number"; then
    return 0
  fi

  echo "Requesting Copilot review for PR #${pr_number}" >&2
  request_copilot_review "$pr_number"
  echo "Copilot review requested successfully" >&2
}

# review human subcommand main
cmd_review_human() {
  if [[ $# -ne 1 ]]; then
    echo "Error: requires exactly 1 argument" >&2
    echo "Usage: scripts/orchestrate review human <pr_number>" >&2
    return 1
  fi

  local pr_number="$1"
  local current_user

  if ! current_user=$(get_gh_user); then
    echo "Error: not authenticated with gh" >&2
    return 1
  fi

  if [[ $current_user == "ianwremmel" ]]; then
    echo "Authenticated as ianwremmel — cannot review own PR, skipping" >&2
    return 0
  fi

  if has_human_review "$pr_number"; then
    return 0
  fi

  echo "Requesting human review for PR #${pr_number}" >&2
  request_human_review "$pr_number"
  echo "Human review requested successfully" >&2
}

# review subcommand main
cmd_review() {
  if [[ $# -lt 1 ]]; then
    echo "Error: requires at least 1 argument" >&2
    echo "Usage: scripts/orchestrate review copilot [--force] <pr_number>" >&2
    echo "       scripts/orchestrate review human <pr_number>" >&2
    return 1
  fi

  local target="$1"
  shift

  case $target in
    copilot)
      cmd_review_copilot "$@"
      ;;
    human)
      cmd_review_human "$@"
      ;;
    *)
      echo "Error: unknown review target '${target}', expected 'copilot' or 'human'" >&2
      return 1
      ;;
  esac
}
