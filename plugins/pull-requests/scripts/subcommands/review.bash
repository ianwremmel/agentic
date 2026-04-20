# subcommands/review - Request Copilot or human reviews, with auth-aware token rotation.
# Sourced by ../orchestrate; defines functions for the `review` subcommand.

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"
source "$SCRIPTS_DIR/lib/gh-auth.bash"
source "$SCRIPTS_DIR/lib/reviews.bash"

# review copilot subcommand main
#
# Human users can request a Copilot review directly with their own
# credentials. Bot / agent accounts usually can't, so if the current auth
# is not a human, we rotate in GH_REVIEW_REQUEST_TOKEN (if provided) for
# the duration of the gh calls.
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
  # Blank token means "keep existing gh credentials"; a non-empty token
  # is rotated in only for this request via a subshell below so GH_TOKEN
  # never leaks into the caller's shell state.
  local rotate_token=""

  if is_human_auth; then
    echo "Authenticated as a human user; using existing credentials" >&2
  else
    if [[ -z ${GH_REVIEW_REQUEST_TOKEN:-} ]]; then
      local current_user
      current_user=$(get_gh_user 2>/dev/null || echo "<unauthenticated>")
      echo "Error: GH_REVIEW_REQUEST_TOKEN must be set when not authenticated as a human (current user: ${current_user})" >&2
      return 1
    fi
    rotate_token="${GH_REVIEW_REQUEST_TOKEN}"
  fi

  # Wrap the gh calls in a subshell so `export GH_TOKEN=...` stays local.
  (
    [[ -n $rotate_token ]] && export GH_TOKEN="$rotate_token"

    if [[ $force == false ]] && has_copilot_review "$pr_number"; then
      exit 0
    fi

    echo "Requesting Copilot review for PR #${pr_number}" >&2
    request_copilot_review "$pr_number"
    echo "Copilot review requested successfully" >&2
  )
}

# review human subcommand main
#
# Requests a review from a specific human reviewer. Skips when the
# agent is already authenticated as that reviewer (can't self-review).
cmd_review_human() {
  if [[ $# -ne 2 ]]; then
    echo "Error: requires exactly 2 arguments" >&2
    echo "Usage: scripts/orchestrate review human <reviewer> <pr_number>" >&2
    return 1
  fi

  local reviewer="$1"
  local pr_number="$2"
  local current_user

  if ! current_user=$(get_gh_user); then
    echo "Error: not authenticated with gh" >&2
    return 1
  fi

  if [[ $current_user == "$reviewer" ]]; then
    echo "Authenticated as ${reviewer} — cannot review own PR, skipping" >&2
    return 0
  fi

  if has_human_review_request "$reviewer" "$pr_number"; then
    return 0
  fi

  echo "Requesting review from ${reviewer} for PR #${pr_number}" >&2
  request_human_review "$reviewer" "$pr_number"
  echo "Review from ${reviewer} requested successfully" >&2
}

# review subcommand main
cmd_review() {
  if [[ $# -lt 1 ]]; then
    echo "Error: requires at least 1 argument" >&2
    echo "Usage: scripts/orchestrate review copilot [--force] <pr_number>" >&2
    echo "       scripts/orchestrate review human <reviewer> <pr_number>" >&2
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
