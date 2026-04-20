# lib/pr-state - Read and mutate PR state: body, mergeability, CI status, and the clc-progress YAML block.
# Sourced; no shebang, no `set -euo pipefail` (the caller provides those).

[[ -n "${__LIB_PR_STATE_LOADED:-}" ]] && return 0
__LIB_PR_STATE_LOADED=1

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"

# Fetches the full PR body
# Arguments:
#   $1 - pr_number
# Returns:
#   PR body text to stdout
get_pr_body() {
  local pr_number="$1"
  retry 3 5 gh pr view "$pr_number" --json body --jq '.body'
}

# Fetches PR state, author, and mergeability
# Arguments:
#   $1 - pr_number
# Returns:
#   JSON with pr_state, pr_author, mergeable to stdout
get_pr_info() {
  if [[ $# -ne 1 ]]; then
    echo "Error: get_pr_info requires exactly 1 argument" >&2
    echo "Usage: get_pr_info <pr_number>" >&2
    return 2
  fi

  local pr_number="$1"

  retry 3 5 gh pr view "$pr_number" \
    --json mergeStateStatus,state,author \
    --jq '{pr_state: .state, pr_author: .author.login, mergeable: .mergeStateStatus}'
}

# Fetches the most recent Buildkite commit status
# Arguments:
#   $1 - sha: The commit SHA
# Returns:
#   JSON with bk_state, bk_desc, bk_url to stdout, or empty string if no BK status
get_bk_status() {
  if [[ $# -ne 1 ]]; then
    echo "Error: get_bk_status requires exactly 1 argument" >&2
    echo "Usage: get_bk_status <sha>" >&2
    return 2
  fi

  local sha="$1"
  local repo
  repo=$(retry 3 5 gh repo view --json nameWithOwner --jq '.nameWithOwner')

  retry 3 5 gh api "repos/${repo}/commits/${sha}/statuses" \
    --jq '[.[] | select(.context | contains("buildkite"))] | sort_by(.updated_at) | last // empty | {bk_state: .state, bk_desc: .description, bk_url: .target_url}'
}

# Extracts the clc-progress YAML from a PR body
# Arguments:
#   $1 - body: The PR body text (via stdin or argument)
# Returns:
#   The YAML content between progress markers to stdout
#   Empty string if no progress block found
extract_progress() {
  local body
  if [[ $# -ge 1 ]]; then
    body="$1"
  else
    body=$(cat)
  fi

  printf '%s\n' "$body" | sed -n '/<!-- clc-progress/,/-->/p' | sed '1d;$d'
}

# Reads the progress block from a PR
# Arguments:
#   $1 - pr_number
# Returns:
#   YAML content to stdout
read_progress() {
  local pr_number="$1"
  local body
  body=$(get_pr_body "$pr_number")
  extract_progress "$body"
}

# Updates specific fields in the progress block
# Arguments:
#   $1 - pr_number
#   $@ - field=value pairs (e.g., phase=ci_monitoring ci_fix_attempts=1)
# Returns:
#   0 on success
write_progress() {
  if [[ $# -lt 2 ]]; then
    echo "Error: write_progress requires pr_number and at least one field=value" >&2
    return 2
  fi

  local pr_number="$1"
  shift

  for pair in "$@"; do
    if [[ ! $pair =~ ^[a-zA-Z_][a-zA-Z0-9_]*= ]]; then
      echo "Error: invalid field=value pair: '$pair'" >&2
      echo "Usage: write_progress <pr_number> field=value ..." >&2
      return 2
    fi
  done

  local body
  body=$(get_pr_body "$pr_number")

  local yaml
  yaml=$(extract_progress "$body")

  # Update fields in the YAML
  local new_yaml="$yaml"
  for pair in "$@"; do
    local key="${pair%%=*}"
    local value="${pair#*=}"
    # Escape sed replacement metacharacters in value
    local escaped_value
    escaped_value=$(printf '%s\n' "$value" | sed 's/[&/\\]/\\&/g')
    if echo "$new_yaml" | grep -q "^${key}:"; then
      new_yaml=$(echo "$new_yaml" | sed "s/^${key}:.*/${key}: ${escaped_value}/")
    else
      new_yaml="${new_yaml}
${key}: ${value}"
    fi
  done

  # Always update last_updated
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if echo "$new_yaml" | grep -q "^last_updated:"; then
    new_yaml=$(echo "$new_yaml" | sed "s/^last_updated:.*/last_updated: ${timestamp}/")
  else
    new_yaml="${new_yaml}
last_updated: ${timestamp}"
  fi

  # Replace the progress block in the body
  local new_block
  new_block="<!-- clc-progress
${new_yaml}
-->"

  local new_body
  if echo "$body" | grep -q '<!-- clc-progress'; then
    # Replace existing block - use awk with ENVIRON to handle newlines
    local block_file
    block_file=$(mktemp)
    echo "$new_block" > "$block_file"
    new_body=$(echo "$body" | awk -v blockfile="$block_file" '
      /<!-- clc-progress/{found=1; while ((getline line < blockfile) > 0) print line; close(blockfile); next}
      found && /-->/{found=0; next}
      !found{print}
    ')
    rm -f "$block_file"
  else
    # Append new block
    new_body="${body}

${new_block}"
  fi

  # Write back via temp file
  local tmpfile
  tmpfile=$(mktemp)
  echo "$new_body" > "$tmpfile"
  retry 3 5 gh pr edit "$pr_number" --body-file "$tmpfile"
  rm -f "$tmpfile"
}

# Updates a checklist item in the Progress section
# Arguments:
#   $1 - pr_number
#   $2 - item_pattern: Text to match in the checklist item (partial match)
#   $3 - state: "checked" or "unchecked"
# Returns:
#   0 on success
update_checklist() {
  if [[ $# -ne 3 ]]; then
    echo "Error: update_checklist requires exactly 3 arguments" >&2
    echo "Usage: update_checklist <pr_number> <item_pattern> <checked|unchecked>" >&2
    return 2
  fi

  local pr_number="$1"
  local item_pattern="$2"
  local state="$3"

  if [[ $state != "checked" && $state != "unchecked" ]]; then
    echo "Error: state must be 'checked' or 'unchecked', got '$state'" >&2
    return 2
  fi

  local body
  body=$(get_pr_body "$pr_number")

  local checkbox
  if [[ $state == "checked" ]]; then
    checkbox="[x]"
  else
    checkbox="[ ]"
  fi

  # Replace the checkbox for the matching item using awk for literal string matching
  local new_body
  new_body=$(printf '%s\n' "$body" | awk -v pattern="$item_pattern" -v checkbox="$checkbox" '
    index($0, pattern) > 0 && /^- \[[ x]\]/ {
      sub(/- \[[ x]\]/, "- " checkbox)
    }
    { print }
  ')

  local tmpfile
  tmpfile=$(mktemp)
  echo "$new_body" > "$tmpfile"
  retry 3 5 gh pr edit "$pr_number" --body-file "$tmpfile"
  rm -f "$tmpfile"
}
