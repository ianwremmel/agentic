# Fetch Available Tickets: Unblocked Issue Discovery for Slot Filling

Subagent protocol for fetching unblocked, ready-to-work tickets with full
descriptions. Also fetches issue relations from Linear and builds a
milestone-scoped dependency graph (cached per milestone). The orchestrator
dispatches a general-purpose subagent with these instructions when it needs to
fill implementation slots.

## Input Variables

The orchestrator provides the following:

- `PROJECT_STATE_PATH` — path to the project state JSON file on disk (e.g.,
  `/tmp/claude/project-state/My Project.json`). Contains `project_id`,
  `milestones`, and `current_milestone_index`. The subagent reads these from the
  file — the orchestrator does NOT pass them as parameters.
- `PROJECT_NAME` — the Linear project name, used for naming the cached graph
  file
- `MILESTONE_ID` — (optional) target milestone; if omitted, use current
  milestone from project state
- `MAX_TICKETS` — maximum number of tickets to return (typically 3-5)
- `EXCLUDE_IDS` — comma-separated list of issue identifiers being actively
  worked on or monitored (non-terminal, non-pending states)
- `DONE_IDS` — comma-separated list of issue identifiers that completed
  successfully (state = `done`)
- `FAILED_IDS` — comma-separated list of issue identifiers that failed, were
  skipped, or were canceled (state = `failed`, `skipped`, or `canceled`).
  Blockers in this set permanently block their dependents — they are NOT treated
  as satisfied.
- `REPO_OWNER` / `REPO_NAME` — GitHub repository coordinates

## Output

- File: `/tmp/claude/available-tickets.json`
- The orchestrator reads ONLY this file — never the subagent's full output.
- The subagent MUST write this file as its FINAL action.

## Steps

1. **Parse inputs and load project state**: Split `EXCLUDE_IDS`, `DONE_IDS`, and
   `FAILED_IDS` into sets (split on comma, trim whitespace). Build
   `ALL_TERMINAL_IDS` = `DONE_IDS` ∪ `FAILED_IDS`. Read `PROJECT_STATE_PATH` to
   extract `project_id` and milestone data:

    ```
    Read PROJECT_STATE_PATH
    ```

    Parse the JSON and set `PROJECT_ID` from `project_id` and
    `PROJECT_ISSUE_SET` from the union of all issue identifiers across all
    milestones. If `MILESTONE_ID` was not provided, resolve it from the project
    state: read `current_milestone_index` and index into `milestones` to get the
    current milestone's ID and name.

2. **Fetch relations for milestone issues**:

    Check for a cached graph at
    `/tmp/claude/project-state/<PROJECT_NAME>.graph.<MILESTONE_ID>.json`. If the
    cached file exists, read it and use the cached graph — set
    `DEPENDENCY_GRAPH` from the cached data and skip to step 3.

    If not cached, fetch relations from Linear. For each issue in the current
    milestone, call:

    ```
    mcp__linear-server__get_issue(id: issue.identifier, includeRelations: true)
    ```

    Batch 5-10 calls in parallel (multiple tool calls in a single message).
    Extract `blockedBy` and `blocks` arrays for each issue.

    Build a milestone-scoped dependency graph (adjacency list: issue identifier
    -> array of blocker identifiers).

    Run cycle detection via DFS on the milestone graph:

    ```
    visited = {}, rec_stack = {}
    function dfs(issue):
      visited[issue] = true, rec_stack[issue] = true
      for each blocker in issue.blockedBy (within same milestone):
        if not visited: if dfs(blocker) returns cycle: return cycle
        else if in rec_stack: return cycle path
      rec_stack.remove(issue)
      return no cycle
    ```

    Record any cycle paths found.

    Check for reverse cross-milestone dependencies: for each relation, if the
    blocker is in a later milestone than the blocked issue, record it as a
    reverse dependency anomaly.

    Cache the graph by writing to
    `/tmp/claude/project-state/<PROJECT_NAME>.graph.<MILESTONE_ID>.json` using
    the Write tool. The cached file should contain:

    ```json
    {
        "milestone_id": "milestone-uuid",
        "dependency_graph": {"CLC-42": ["CLC-40", "CLC-41"]},
        "cycles": [],
        "reverse_deps": []
    }
    ```

3. **Fetch issues for milestone**:

    ```
    mcp__linear-server__list_issues(project: PROJECT_ID)
    ```

    Filter results to issues in the resolved `MILESTONE_ID`. Paginate with
    `cursor` if needed to collect all issues.

4. **Build milestone issue set and filter**: First, collect ALL issue
   identifiers in this milestone into `MILESTONE_ISSUE_SET` (before any
   filtering). Then remove from the candidate set:
    - Issues whose identifier is in `EXCLUDE_IDS`
    - Issues whose identifier is in `ALL_TERMINAL_IDS` (`DONE_IDS` ∪
      `FAILED_IDS`)
    - Issues in terminal Linear states (Done, Canceled)

    Remaining issues are candidates. Keep `MILESTONE_ISSUE_SET` for step 5.

5. **Compute unblocked and permanently blocked sets**: For each candidate:
    - Look up its blockers in the milestone-scoped `DEPENDENCY_GRAPH` (built or
      loaded from cache in step 2)
    - For each blocker, classify it:
        - **Satisfied**: blocker is in `DONE_IDS` (successfully completed),
          regardless of which milestone it belongs to
        - **Permanently failed**: blocker is in `FAILED_IDS` (failed, skipped,
          or canceled — its deliverable will never arrive), regardless of
          milestone
        - **External (non-project)**: blocker is NOT in the project's full issue
          set at all — it references an issue outside this project. Treat as
          **still blocking** (the orchestrator cannot track its completion)
        - **Still blocking**: blocker is in the project's full issue set, is NOT
          in `DONE_IDS`, and is NOT in `FAILED_IDS` (it's either pending or
          in-progress/excluded). This applies whether the blocker is in
          `MILESTONE_ISSUE_SET` or in an earlier milestone — an
          earlier-milestone blocker that hasn't completed yet must still block
    - An issue is **unblocked** only if it has ZERO "still blocking" AND ZERO
      "permanently failed" blockers
    - An issue is **permanently blocked** if it has one or more "permanently
      failed" blockers (regardless of other blocker states)
    - Issues with NO entry in `DEPENDENCY_GRAPH` are unblocked (no blockers)

    **Critical**: Do NOT treat excluded/in-progress blockers as satisfied. A
    blocker in `EXCLUDE_IDS` is actively being worked on but not yet complete —
    its dependent must wait.

    **Critical**: Do NOT treat failed/skipped blockers as satisfied. A blocker
    in `FAILED_IDS` means its deliverable will never arrive — the dependent is
    permanently blocked and should be marked `skipped`.

    Collect permanently blocked issues into a separate list with their failed
    blockers. These are included in the output's `permanently_blocked` array so
    the orchestrator can mark them as `skipped`.

    Also check issues in OTHER milestones: scan the full `DEPENDENCY_GRAPH`, but
    only consider issues that are in `PROJECT_ISSUE_SET`, are NOT in
    `ALL_TERMINAL_IDS`, and are NOT in `EXCLUDE_IDS`. For those remaining
    issues, if they have a blocker in `FAILED_IDS`, include them in
    `permanently_blocked` too — this catches cross-milestone dependents that
    would otherwise be scheduled in later milestones without repeatedly
    returning already-terminal issues.

6. **Rank unblocked issues** using this priority order:
    1. **Resumed issues first** — issues that have existing worktrees or PRs get
       priority (detected in step 9)
    2. **By priority** — Linear `priority` field (lower number = higher
       priority; 0 = no priority, sort last)
    3. **By downstream impact** — count of issues transitively blocked by this
       one (more downstream = higher priority)

    Note: Step 9 (resume detection) feeds back into ranking. Perform a
    preliminary rank by priority and downstream impact, then re-rank after
    resume detection promotes resumed issues to the top.

7. **Select top N**: Take up to `MAX_TICKETS` from the ranked list.

8. **Fetch full descriptions**: For each selected issue, call in parallel
   (multiple tool calls in a single message):

    ```
    mcp__linear-server__get_issue(id: issue.identifier)
    ```

    Extract the full `description` field from each response.

9. **Check resume state** for each selected issue:

    a. Check for existing worktrees:

    ```bash
    git worktree list --porcelain
    ```

    Match each worktree path against the issue's `gitBranchName`. If found,
    record the worktree directory and branch name.

    b. If a worktree exists, check for an associated PR:

    ```bash
    gh pr list --head <branch-name> --state open --json number,isDraft,state --limit 1
    ```

    c. If a PR exists, read the PR body and extract the YAML between
    `<!-- clc-progress` and `-->`. Parse:
    - `phase` → map to resume state
    - `ci_fix_attempts` → counter
    - `review_cycles` → counter
    - `commit_scope` → scope string

    d. Record resume state as an object, or `null` if no worktree found.

10. **Compute downstream counts**: For each selected issue, walk the
    milestone-scoped dependency graph forward (invert the graph built/loaded in
    step 2 to find which issues each key blocks) and count all transitively
    blocked issues.

11. **Write output JSON** to `/tmp/claude/available-tickets.json`.

## Output JSON Schema

```json
{
    "fetched_at": "2026-02-28T12:00:00Z",
    "milestone_id": "milestone-uuid",
    "milestone_name": "Milestone 1",

    "available": [
        {
            "identifier": "CLC-42",
            "title": "Implement widget API",
            "description": "Full ticket description for implementation brief...",
            "git_branch_name": "ianwremmel/clc-42-implement-widget-api",
            "url": "https://linear.app/...",
            "priority": 2,
            "labels": ["backend", "api"],
            "downstream_count": 3,
            "resume_state": null
        },
        {
            "identifier": "CLC-40",
            "title": "Set up widget package",
            "description": "Detailed description...",
            "git_branch_name": "ianwremmel/clc-40-set-up-widget-package",
            "url": "https://linear.app/...",
            "priority": 1,
            "labels": ["infra"],
            "downstream_count": 5,
            "resume_state": {
                "state": "implementing",
                "worktree_dir": "/Users/ian/projects/worktrees/apps/ianwremmel/clc-40-...",
                "branch_name": "ianwremmel/clc-40-...-2026-02-28T120000",
                "pr_number": 1234,
                "ci_fix_attempts": 0,
                "review_cycles": 0,
                "commit_scope": "widget"
            }
        }
    ],

    "permanently_blocked": [
        {
            "identifier": "CLC-45",
            "failed_blockers": ["CLC-43"]
        }
    ],

    "anomalies": {
        "cycles": [],
        "reverse_deps": []
    },

    "counts": {
        "total_in_milestone": 8,
        "excluded": 3,
        "terminal": 2,
        "blocked": 1,
        "permanently_blocked": 1,
        "unblocked": 2
    }
}
```

### Field Descriptions

- `fetched_at` — ISO 8601 timestamp of when this data was fetched
- `milestone_id` — the milestone UUID used for filtering
- `milestone_name` — human-readable milestone name
- `available` — ordered list of tickets ranked by priority (best candidate
  first), up to `MAX_TICKETS` entries
- `available[].identifier` — Linear issue identifier (e.g., "CLC-42")
- `available[].title` — issue title
- `available[].description` — FULL Linear ticket description; this is the
  implementation brief the orchestrator passes to implementation subagents
- `available[].git_branch_name` — Linear's suggested git branch name for the
  issue
- `available[].url` — Linear issue URL
- `available[].priority` — Linear priority field (1=urgent, 2=high, 3=medium,
  4=low, 0=no priority)
- `available[].labels` — array of label names from Linear
- `available[].downstream_count` — number of issues transitively blocked by this
  one; higher values mean starting this issue unblocks more work
- `available[].resume_state` — `null` for fresh issues, or an object with all
  state needed to resume work
- `available[].resume_state.state` — mapped from `clc-progress` phase
  (implementing, ci_monitoring, etc.)
- `available[].resume_state.worktree_dir` — absolute path to the existing
  worktree
- `available[].resume_state.branch_name` — git branch name in the worktree
- `available[].resume_state.pr_number` — GitHub PR number if one exists
- `available[].resume_state.ci_fix_attempts` — counter from progress block
- `available[].resume_state.review_cycles` — counter from progress block
- `available[].resume_state.commit_scope` — conventional commit scope from
  progress block
- `permanently_blocked` — array of issues that can never be unblocked because
  one or more of their blockers are in `FAILED_IDS`. The orchestrator uses this
  to mark them as `skipped`. Includes issues from ALL milestones that have
  failed blockers, not just the current milestone.
- `permanently_blocked[].identifier` — Linear issue identifier
- `permanently_blocked[].failed_blockers` — array of blocker identifiers that
  are in `FAILED_IDS`
- `counts.total_in_milestone` — total issues in the milestone
- `counts.excluded` — count of issues filtered out by `EXCLUDE_IDS`
- `counts.terminal` — count of issues filtered out by terminal Linear state
- `counts.blocked` — count of candidate issues still blocked by in-progress
  dependencies (will eventually unblock)
- `counts.permanently_blocked` — count of permanently blocked issues **in the
  current milestone only** (subset of the `permanently_blocked` array, which
  also includes cross-milestone entries)
- `counts.unblocked` — total number of unblocked issues (not just the returned
  `MAX_TICKETS`)

## Error Handling

On error at any step, write to the output file:

```json
{
    "error": true,
    "step": "<step_name>",
    "message": "Description of what failed",
    "partial": {
        "available": []
    }
}
```

Step names for error reporting: `parse_inputs`, `fetch_relations`,
`build_graph`, `fetch_issues`, `filter_issues`, `compute_unblocked`,
`rank_issues`, `fetch_descriptions`, `check_resume_state`, `compute_downstream`,
`write_output`.

If the error occurs after some tickets have been successfully processed, include
them in `partial.available` so the orchestrator can still use partial results.

## Notes

- Use `Grep` tool (not grep/rg commands), `Read` tool (not cat/head/tail),
  `Edit`/`Write` tools (not sed/awk/echo) for all file operations.
- Do NOT edit any `package.json` files.
- The Linear MCP tools are deferred — they must be loaded via `ToolSearch`
  before first use.
- For GitHub MCP calls, if the primary MCP tool fails, fall back to `gh` CLI.
- The milestone-scoped dependency graph is cached at
  `/tmp/claude/project-state/<PROJECT_NAME>.graph.<MILESTONE_ID>.json`. The
  subagent reads the cache if it exists; otherwise it fetches relations from
  Linear and writes the cache. To force a rebuild (e.g., after tickets are
  created or moved during milestone review), delete the cached graph file before
  dispatching this subagent.
- The subagent MUST re-read `PROJECT_STATE_PATH` on every invocation — do not
  cache project state across calls (milestone data may have changed).
- The subagent must write the output JSON file as its FINAL action.
