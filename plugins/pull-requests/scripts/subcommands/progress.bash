# subcommands/progress - Read and update the clc-progress YAML block embedded in PR bodies.
# Sourced by ../orchestrate; defines functions for the `progress` subcommand.

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$SCRIPTS_DIR/lib/_retry.bash"
source "$SCRIPTS_DIR/lib/pr-state.bash"

# progress subcommand main
cmd_progress() {
  if [[ $# -lt 2 ]]; then
    echo "Error: requires at least 2 arguments" >&2
    echo "Usage: scripts/orchestrate progress read <pr_number>" >&2
    echo "       scripts/orchestrate progress write <pr_number> [field=value ...]" >&2
    echo "       scripts/orchestrate progress checklist <pr_number> <item> <checked|unchecked>" >&2
    return 1
  fi

  local command="$1"
  shift

  case $command in
    read)
      if [[ $# -ne 1 ]]; then
        echo "Error: read requires exactly 1 argument" >&2
        return 1
      fi
      read_progress "$1"
      ;;
    write)
      write_progress "$@"
      ;;
    checklist)
      update_checklist "$@"
      ;;
    *)
      echo "Error: unknown command '$command'" >&2
      echo "Usage: scripts/orchestrate progress read|write|checklist ..." >&2
      return 1
      ;;
  esac
}
