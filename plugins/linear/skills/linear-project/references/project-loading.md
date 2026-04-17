# Project Loading: Fetch and Initialize from Linear

All heavy data fetching is delegated to a subagent that writes compact JSON to a
temp file. The orchestrator reads only the JSON file, keeping its context clean.

## Steps

1. **Parse project name** from skill arguments. Set `PROJECT_NAME`.

2. **Extract repository info** from git remote:

    ```bash
    git remote get-url origin | sed -E 's|.*[:/]([^/]+)/([^/.]+)(\.git)?$|\1 \2|'
    ```

    Set `REPO_OWNER` and `REPO_NAME`.

3. **Create temp directories**:

    ```bash
    mkdir -p /tmp/claude/project-state /tmp/claude/issue-status
    ```

4. **Dispatch overview subagent** — a `general-purpose` agent
   (`run_in_background: true`). Dispatch brief:

    > Read and follow
    > `/Users/ian/projects/apps/.claude/skills/linear-project/references/fetch-project-overview.md`.
    >
    > Variables:
    >
    > - `PROJECT_NAME` = `<value>`
    > - `REPO_OWNER` = `<value>`
    > - `REPO_NAME` = `<value>`

    The subagent fetches the project, milestones, issues, performs resume
    detection, and writes results to
    `/tmp/claude/project-state/<PROJECT_NAME>.json`.

5. **Wait for subagent completion** — check via `TaskOutput(block=false)` on a
   short interval. When complete, do NOT read the full transcript. Proceed to
   step 6.

6. **Read the output file**:

    ```
    Read /tmp/claude/project-state/<PROJECT_NAME>.json
    ```

    This single read replaces all the inline MCP calls from the previous
    approach.

7. **Handle errors**: If the JSON contains `"error": true`, report to user with
   the `step` and `message` fields. If `partial` data is present, include it in
   the report. Then stop.

8. **Populate orchestrator state** from the JSON — extract ONLY these fields
   into context:
    - `PROJECT_ID` from `project_id`
    - `PROJECT_STATE_PATH` — the file path itself
      (`/tmp/claude/project-state/<PROJECT_NAME>.json`). Subagents read issue
      metadata from this file on demand.
    - `MILESTONES` from `milestones` array
    - `CURRENT_MILESTONE_INDEX` from `current_milestone_index`
    - `ISSUE_STATE` — initialize from each issue's `state` field. For issues in
      `resumed_issues`, use their `state` from that map instead.
    - `ISSUE_PR_MAP` — for each entry in `resumed_issues`, populate
      `{branchName, worktreeDir, prNumber}`.
    - Per-issue counters — from `resumed_issues` entries: `ci_fix_attempts`,
      `review_cycles`, `commit_scope`, watermarks.

9. **Report project summary** to user:

    ```
    Project: <PROJECT_NAME>
    Milestones: <count> (<list of names>)
    Total issues: <total_issues> (<terminal_count> already done, <remaining_count> to process)
    Current milestone: <milestones[current_milestone_index].name>
    Resumed in-progress: <count of entries in resumed_issues>
    ```
