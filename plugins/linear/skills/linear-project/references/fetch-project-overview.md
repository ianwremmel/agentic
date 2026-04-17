# Fetch Project Overview: Subagent Protocol for Loading Linear Project State

Dispatched as a `general-purpose` subagent by the orchestrator. Fetches all
project data from Linear, detects resumed work, and writes a compact JSON file.
The orchestrator reads only the JSON output — never the subagent's full
transcript.

## Input Variables

The orchestrator provides these in the dispatch brief:

- `PROJECT_NAME` — the Linear project name (exact match required)
- `REPO_OWNER` — GitHub repository owner (e.g., `ianwremmel`)
- `REPO_NAME` — GitHub repository name (e.g., `apps`)

## Output

- **Primary file**: `/tmp/claude/project-state/<PROJECT_NAME>.json`
- **Side effect**: Creates `/tmp/claude/issue-status/` directory

The subagent MUST write the output JSON file as its FINAL action. The
orchestrator waits for completion then reads only this file.

## Steps

### 1. Fetch the project

Load all required Linear MCP tools via `ToolSearch`, then fetch:

```
ToolSearch(query: "+linear list projects")
ToolSearch(query: "+linear list milestones")
ToolSearch(query: "+linear list issues")
mcp__linear-server__list_projects(query: PROJECT_NAME)
```

Find exact match by name. If multiple results, select the one whose name matches
exactly. If not found, retry up to 3 times with 5-second delays, then write
error JSON (see Error Handling) and exit.

Set `PROJECT_ID` from the result.

### 2. Fetch milestones

```
mcp__linear-server__list_milestones(project: PROJECT_ID)
```

Sort by `sortOrder`. If no milestones exist, create a synthetic "All Issues"
milestone with `id: "synthetic-all"`, `sort_order: 0`.

### 3. Fetch all project issues

```
mcp__linear-server__list_issues(project: PROJECT_ID)
```

Paginate with `cursor` if more than one page. Collect all issues.

### 4. Partition issues into milestones

Group issues by their `milestone` field. Issues without a milestone assignment
go into a synthetic "Unassigned" milestone appended at the end.

### 5. Filter terminal issues

Issues in "Done" or "Canceled" Linear status:

- "Done" -> `state: "done"`
- "Canceled" -> `state: "canceled"`

All other issues default to `state: "pending"` (overridden by resume detection
in step 6).

### 6. Resume detection

**a. Detect existing worktrees**: Run `git worktree list --porcelain` via Bash.
For each project issue, check if any worktree path contains the issue's
`gitBranchName`. If found, record `worktree_dir` and extract `branch_name`.

**b. List open PRs** via GitHub MCP (primary) with CLI fallback:

```
ToolSearch(query: "+github list pull requests")
mcp__github__list_pull_requests(owner: REPO_OWNER, repo: REPO_NAME, state: "open")
```

Fallback:

```bash
gh pr list --state open --json number,headRefName,isDraft --limit 100
```

Match PRs to issues by branch name.

**c. Read PR progress blocks**: For each issue with a matching PR, read the PR
body and extract the YAML between `<!-- clc-progress` and `-->`. Map `phase` to
state:

| `phase` value       | Issue `state`        |
| ------------------- | -------------------- |
| `implementation`    | `implementing`       |
| `pre_push`          | `implementing`       |
| `ci_monitoring`     | `ci_monitoring`      |
| `completion`        | `ready_for_review`   |
| `review_monitoring` | `monitoring_reviews` |
| `done`              | `done`               |

**d. Heuristic fallback** (no progress block present):

| PR condition                          | Issue `state`        |
| ------------------------------------- | -------------------- |
| Merged                                | `done`               |
| Closed without merge                  | `failed`             |
| Draft, only empty commit              | `setup`              |
| Draft, has implementation commits     | `ci_monitoring`      |
| Ready, CI failing                     | `ci_monitoring`      |
| Ready, CI passing, no reviews         | `ready_for_review`   |
| Ready, reviews with changes requested | `monitoring_reviews` |
| Ready, approved                       | `waiting_for_merge`  |

**e. Extract per-issue counters** from the progress block when present:
`ci_fix_attempts`, `review_cycles`, `commit_scope`, and watermark values
(`watermark_review_id`, `watermark_comment_id`, `watermark_issue_comment_id`).

### 7. Compute current milestone

First milestone (by `sort_order`) where `is_complete == false` — i.e., it has at
least one issue not in a terminal state (`done` or `canceled`).

### 8. Write output JSON

Ensure the output directory exists, then write the JSON file:

```bash
mkdir -p /tmp/claude/project-state
```

Write to `/tmp/claude/project-state/<PROJECT_NAME>.json` using the Write tool.
See Output JSON Schema below for the full structure.

### 9. Create status directory

```bash
mkdir -p /tmp/claude/issue-status
```

## Output JSON Schema

```json
{
    "project_id": "uuid-string",
    "project_name": "My Project",
    "fetched_at": "2026-02-28T12:00:00Z",

    "milestones": [
        {
            "id": "milestone-uuid",
            "name": "Milestone 1",
            "sort_order": 0,
            "issue_count": 8,
            "status_counts": {
                "pending": 3,
                "done": 2,
                "canceled": 1,
                "in_progress": 2
            },
            "is_complete": false
        }
    ],

    "current_milestone_index": 0,
    "total_issues": 20,
    "terminal_count": 5,
    "remaining_count": 15,

    "issues": [
        {
            "identifier": "CLC-42",
            "title": "Implement widget API",
            "milestone_id": "milestone-uuid",
            "state": "pending"
        }
    ],

    "resumed_issues": {
        "CLC-40": {
            "state": "ci_monitoring",
            "worktree_dir": "/Users/ian/projects/worktrees/apps/ianwremmel/clc-40-...",
            "branch_name": "ianwremmel/clc-40-...-2026-02-28T120000",
            "pr_number": 1234,
            "ci_fix_attempts": 1,
            "review_cycles": 0,
            "commit_scope": "widget",
            "watermark_review_id": 0,
            "watermark_comment_id": 0,
            "watermark_issue_comment_id": 0
        }
    }
}
```

### Field Notes

- `issues[].state` is initialized from resume detection or defaults to
  `"pending"`. Terminal Linear statuses map to `"done"` or `"canceled"`.
- `issues` does NOT include `description`, `priority`, `labels`,
  `git_branch_name`, or `url` — these are fetched lazily by
  `fetch-available-tickets.md` when tickets are about to be dispatched.
- `resumed_issues` only contains entries for issues with existing
  work-in-progress. All fields needed to populate the orchestrator's
  `ISSUE_PR_MAP` and per-issue counters.
- `milestones[].status_counts.in_progress` aggregates all non-terminal,
  non-pending states (`implementing`, `ci_monitoring`, `ready_for_review`,
  `monitoring_reviews`, `waiting_for_merge`).

## Error Handling

On error at any step, write to the output file:

```json
{
    "error": true,
    "step": "fetch_project",
    "message": "Project 'FooBar' not found after 3 retries",
    "partial": {}
}
```

The `step` field identifies where the failure occurred. Use one of:
`fetch_project`, `fetch_milestones`, `fetch_issues`, `resume_detection`,
`write_output`.

The `partial` field contains any data successfully collected before the failure
(e.g., milestones and issues if relation-fetching failed). The orchestrator
reads this and reports to the user.

## Notes

- Use `Grep` tool (not grep/rg commands), `Read` tool (not cat/head/tail),
  `Edit`/`Write` tools (not sed/awk/echo) for all file operations.
- Do NOT edit any `package.json` files.
- The Linear MCP tools are deferred — they must be loaded via `ToolSearch`
  before first use.
- For GitHub MCP calls, if the primary MCP tool fails, fall back to `gh` CLI
  commands.
- The subagent must write the output JSON file as its FINAL action.
