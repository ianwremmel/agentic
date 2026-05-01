# lib/reviews - Fetch reviews, manage Copilot/human review requests, and compute approval state.
# Sourced; no shebang, no `set -euo pipefail` (the caller provides those).

[[ -n "${__LIB_REVIEWS_LOADED:-}" ]] && return 0
__LIB_REVIEWS_LOADED=1

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"

# Fetches ALL reviews for a PR (no watermark filtering)
# Arguments:
#   $1 - pr_number
# Returns:
#   JSON array of all reviews with id, state, body, user_login, user_type, commit_id
fetch_all_reviews() {
  if [[ $# -ne 1 ]]; then
    echo "Error: fetch_all_reviews requires exactly 1 argument" >&2
    echo "Usage: fetch_all_reviews <pr_number>" >&2
    return 2
  fi

  local pr_number="$1"
  local repo
  repo=$(retry 3 5 gh repo view --json nameWithOwner --jq '.nameWithOwner')

  retry 3 5 gh api "repos/${repo}/pulls/${pr_number}/reviews" \
    --paginate \
    --jq "[.[] | {id: .id, state: .state, body: .body, user_login: .user.login, user_type: .user.type, commit_id: .commit_id}]"
}

# Computes approval state from all reviews.
# Copilot reviews are excluded so `poll`'s approval_state agrees with
# `check-status`, which also ignores copilot for this purpose.
# Arguments:
#   $1 - all_reviews_json_array: Full review list (not watermark-filtered)
# Returns:
#   One of: APPROVED, CHANGES_REQUESTED, PENDING
compute_approval_state() {
  if [[ $# -ne 1 ]]; then
    echo "Error: compute_approval_state requires exactly 1 argument" >&2
    echo "Usage: compute_approval_state <all_reviews_json>" >&2
    return 2
  fi

  local all_reviews="$1"

  echo "$all_reviews" | jq -r '
    [.[]
      | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")
      | select((.user_login // "") | ascii_downcase | startswith("copilot") | not)
    ]
    | sort_by(.user_login)
    | group_by(.user_login)
    | map(sort_by(.id) | last)
    | if any(.state == "CHANGES_REQUESTED") then "CHANGES_REQUESTED"
      elif any(.state == "APPROVED") then "APPROVED"
      else "PENDING"
      end
  '
}

# Checks if Copilot has already been requested as a reviewer or has submitted a review
# Arguments:
#   $1 - pr_number: The pull request number
# Returns:
#   0 if Copilot review already exists, 1 otherwise
has_copilot_review() {
  if [[ $# -ne 1 ]]; then
    echo "Error: has_copilot_review requires exactly 1 argument" >&2
    echo "Usage: has_copilot_review <pr_number>" >&2
    return 2
  fi

  local pr_number="$1"

  if gh pr view "$pr_number" --json reviewRequests \
       --jq '.reviewRequests[].login' | grep -qx "copilot"; then
    echo "Copilot review already requested" >&2
    return 0
  fi

  if gh pr view "$pr_number" --json reviews \
       --jq '.reviews[].author.login' | grep -qx "copilot"; then
    echo "Copilot has already reviewed" >&2
    return 0
  fi

  return 1
}

# Requests a Copilot review on a pull request
# Arguments:
#   $1 - pr_number: The pull request number
# Returns:
#   0 on success, non-zero on failure
request_copilot_review() {
  if [[ $# -ne 1 ]]; then
    echo "Error: request_copilot_review requires exactly 1 argument" >&2
    echo "Usage: request_copilot_review <pr_number>" >&2
    return 2
  fi

  local pr_number="$1"

  gh pr edit "$pr_number" --add-reviewer @copilot
}

# Checks whether a specific human reviewer has a pending review request
# on a PR. Only checks reviewRequests (pending), not reviews (submitted),
# so callers can re-request review after the reviewer submits
# CHANGES_REQUESTED and the agent addresses the feedback.
# Arguments:
#   $1 - reviewer: The reviewer's GitHub login
#   $2 - pr_number: The pull request number
# Returns:
#   0 if the reviewer has a pending review request, 1 otherwise
has_human_review_request() {
  if [[ $# -ne 2 ]]; then
    echo "Error: has_human_review_request requires exactly 2 arguments" >&2
    echo "Usage: has_human_review_request <reviewer> <pr_number>" >&2
    return 2
  fi

  local reviewer="$1"
  local pr_number="$2"

  if gh pr view "$pr_number" --json reviewRequests \
       --jq '.reviewRequests[].login' | grep -qx "$reviewer"; then
    echo "Review from ${reviewer} already requested" >&2
    return 0
  fi

  return 1
}

# Requests a review from a specific human reviewer on a pull request.
# Arguments:
#   $1 - reviewer: The reviewer's GitHub login
#   $2 - pr_number: The pull request number
# Returns:
#   0 on success, non-zero on failure
request_human_review() {
  if [[ $# -ne 2 ]]; then
    echo "Error: request_human_review requires exactly 2 arguments" >&2
    echo "Usage: request_human_review <reviewer> <pr_number>" >&2
    return 2
  fi

  local reviewer="$1"
  local pr_number="$2"

  gh pr edit "$pr_number" --add-reviewer "$reviewer"
}
