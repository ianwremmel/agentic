# subcommands/check-status - Aggregate check-runs / status-checks state for a PR head SHA.
# Sourced by ../orchestrate; defines functions for the `check-status` subcommand.

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"

# Fetches compact PR status for polling (~4+ API calls; paginated)
# Arguments:
#   $1 - pr_number
# Returns:
#   JSON to stdout with merged, closed, ci_state, has_feedback, copilot_clean,
#   labels, needs_copilot_request, approval_state
#   Exit 0 on success (including when CI status fetch fails — reported as
#   ci_state="error"). Exit 1 only when PR metadata or repo lookup fails.
fetch_check_status() {
  if [[ $# -ne 1 ]]; then
    echo "Error: fetch_check_status requires exactly 1 argument" >&2
    echo "Usage: fetch_check_status <pr_number>" >&2
    return 2
  fi

  local pr_number="$1"

  # API call 1: PR metadata (state, labels, reviews, review requests, head SHA)
  local pr_data
  if ! pr_data=$(retry 3 5 gh pr view "$pr_number" \
    --json state,labels,reviews,reviewRequests,headRefOid \
    --jq '{
      state: .state,
      labels: [.labels[].name],
      reviews: [.reviews[] | {state: .state, author: .author.login}],
      review_requests: [.reviewRequests[].login // empty | select(type == "string")],
      head_sha: .headRefOid
    }'); then
    echo "Error: failed to fetch PR #${pr_number}" >&2
    return 1
  fi

  local pr_state
  pr_state=$(echo "$pr_data" | jq -r '.state')
  local head_sha
  head_sha=$(echo "$pr_data" | jq -r '.head_sha')
  local merged=false
  local closed=false

  if [[ $pr_state == "MERGED" ]]; then
    merged=true
  fi
  if [[ $pr_state == "CLOSED" ]]; then
    closed=true
  fi

  # Repo name — needed by both CI status and inline comment API calls
  local repo
  if ! repo=$(retry 3 5 gh repo view --json nameWithOwner --jq '.nameWithOwner'); then
    echo "Error: failed to determine repository name" >&2
    return 1
  fi

  # API call 2: CI status from commit statuses
  local ci_state="pending"
  if [[ -n $head_sha ]] && [[ $head_sha != "null" ]]; then
    local bk_status
    if bk_status=$(retry 3 5 gh api "repos/${repo}/commits/${head_sha}/statuses" \
      --jq '[.[] | select(.context | contains("buildkite"))] | sort_by(.updated_at) | last // empty | .state'); then
      if [[ -n $bk_status ]]; then
        ci_state="$bk_status"
      fi
    else
      ci_state="error"
    fi
  fi

  # Compute approval_state from reviews (last review per author wins)
  # Filter out copilot reviews, sort by author for group_by, then pick the
  # last actionable review per author (sorted by array index as proxy for time)
  local approval_state
  approval_state=$(echo "$pr_data" | jq -r '
    [.reviews[] | select(.author | ascii_downcase | startswith("copilot") | not)]
    | [to_entries[] | .value + {idx: .key}]
    | [.[] | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")]
    | sort_by(.author)
    | group_by(.author)
    | map(sort_by(.idx) | last)
    | if any(.state == "CHANGES_REQUESTED") then "CHANGES_REQUESTED"
      elif any(.state == "APPROVED") then "APPROVED"
      else "PENDING"
      end
  ')

  # API call 3: Fetch inline comments to detect unresolved feedback.
  # Without this, we miss Copilot suggestions and human inline comments that
  # don't use CHANGES_REQUESTED review state.
  local inline_comments='[]'
  local inline_comments_raw
  if inline_comments_raw=$(retry 3 5 gh api "repos/${repo}/pulls/${pr_number}/comments" \
    --paginate \
    --jq '.[] | {id: .id, user_login: .user.login, user_type: .user.type, body: .body, in_reply_to_id: .in_reply_to_id}' \
    | jq -s '.'); then
    inline_comments="$inline_comments_raw"
  else
    # Comment fetch failed — assume unresolved feedback exists so we don't
    # silently skip review comments due to a transient API error.
    echo "Warning: failed to fetch inline comments for PR #${pr_number}" >&2
    inline_comments='[{"_fetch_error": true}]'
  fi

  # Identify top-level (non-reply) comments that are NOT agent replies.
  # A comment is "addressed" if it has an agent reply (a reply with
  # "<!-- agent-reply -->" in the body). Comments without agent replies are
  # unresolved feedback.
  # If comment fetch failed, assume unresolved feedback to be safe
  local unresolved_human_count=0
  local unresolved_copilot_count=0
  # Only exit code needed — check if sentinel was set by failed API call
  if echo "$inline_comments" | jq -e '.[0]._fetch_error // false' > /dev/null 2>&1; then
    unresolved_human_count=1
    unresolved_copilot_count=1
  else
    local agent_reply_parent_ids
    agent_reply_parent_ids=$(echo "$inline_comments" | jq '[.[] | select(.body | contains("<!-- agent-reply -->")) | .in_reply_to_id] | unique')

    # Unresolved human comments: top-level non-bot comments without an agent reply.
    # Only reply comments (in_reply_to_id != null) carry the agent-reply marker;
    # top-level comments are resolved when their id appears in $replied.
    unresolved_human_count=$(echo "$inline_comments" | jq --argjson replied "$agent_reply_parent_ids" '
      [.[]
        | select(.user_type != "Bot")
        | select(.in_reply_to_id == null)
        | select([.id] | inside($replied) | not)
      ] | length
    ')

    # Unresolved Copilot comments: top-level Copilot comments without an agent reply
    unresolved_copilot_count=$(echo "$inline_comments" | jq --argjson replied "$agent_reply_parent_ids" '
      [.[]
        | select(.user_login | ascii_downcase | startswith("copilot"))
        | select(.in_reply_to_id == null)
        | select([.id] | inside($replied) | not)
      ] | length
    ')
  fi

  # Compute has_feedback: true if CHANGES_REQUESTED OR unresolved inline comments
  local has_feedback
  local has_changes_requested
  has_changes_requested=$(echo "$pr_data" | jq -r '
    ([.reviews[] | select(.author | ascii_downcase | startswith("copilot") | not) | select(.state == "CHANGES_REQUESTED")] | length > 0)
  ')
  if [[ $has_changes_requested == "true" ]] || [[ $unresolved_human_count -gt 0 ]]; then
    has_feedback=true
  else
    has_feedback=false
  fi

  # Compute copilot_clean: copilot has reviewed AND has no unresolved comments
  # AND is not currently pending re-review
  local copilot_has_reviewed
  copilot_has_reviewed=$(echo "$pr_data" | jq -r '
    [.reviews[] | select(.author | ascii_downcase | startswith("copilot"))] | length > 0
  ')

  local copilot_requested
  copilot_requested=$(echo "$pr_data" | jq -r '
    [.review_requests[] | select(ascii_downcase | startswith("copilot"))] | length > 0
  ')

  local copilot_clean=false
  if [[ $copilot_has_reviewed == "true" ]] && [[ $copilot_requested == "false" ]] && [[ $unresolved_copilot_count -eq 0 ]]; then
    copilot_clean=true
  fi

  # needs_copilot_request: copilot has never reviewed AND is not currently requested
  local needs_copilot_request=false
  if [[ $copilot_has_reviewed == "false" ]] && [[ $copilot_requested == "false" ]]; then
    needs_copilot_request=true
  fi

  # Extract labels array
  local labels
  labels=$(echo "$pr_data" | jq -c '.labels')

  # Assemble output JSON
  jq -n \
    --argjson merged "$merged" \
    --argjson closed "$closed" \
    --arg ci_state "$ci_state" \
    --argjson has_feedback "$has_feedback" \
    --argjson copilot_clean "$copilot_clean" \
    --argjson labels "$labels" \
    --argjson needs_copilot_request "$needs_copilot_request" \
    --arg approval_state "$approval_state" \
    '{
      merged: $merged,
      closed: $closed,
      ci_state: $ci_state,
      has_feedback: $has_feedback,
      copilot_clean: $copilot_clean,
      labels: $labels,
      needs_copilot_request: $needs_copilot_request,
      approval_state: $approval_state
    }'
}

# check-status subcommand main
cmd_check_status() {
  if [[ $# -ne 1 ]]; then
    echo "Error: requires exactly 1 argument" >&2
    echo "Usage: scripts/orchestrate check-status <pr_number>" >&2
    return 1
  fi

  fetch_check_status "$1"
}
