# Fix Failing Dependabot PRs

This reference describes how to investigate and fix build failures on dependabot
branches. For each failing PR, a fix PR is created targeting the dependabot
branch (not main).

## Prerequisites

The orchestrator provides:

- `FIX_PRS` — subset of failing Dependabot PRs selected for fix attempts (max 3)
- `REPO_OWNER` / `REPO_NAME` — repository coordinates
- `WORKTREE_DIR` (main worktree) — not used directly; each fix gets its own
  worktree

**Note:** The orchestrator has already filtered out PRs with existing open fix
attempts (PRs targeting the dependabot branch). Every PR in `FIX_PRS` is
guaranteed to have no existing open fix PR — no need to re-check.

## Limits and Constraints

- **Max 3 concurrent fix attempts** (oldest failing PRs first by PR number)
- **1 CI attempt per fix** — if the fix fails CI, report and move on
- **No review monitoring** — these are small automated fixes
- **Do NOT auto-merge** — let the user decide

## Flow Per Failing PR

### 1. Investigate

Fetch the Buildkite build for the PR's head commit:

```bash
gh api repos/$REPO_OWNER/$REPO_NAME/commits/<headRefOid>/status --jq '.statuses[] | select(.context | contains("buildkite"))'
```

Extract the Buildkite build URL from the `target_url` field, then fetch build
details:

```
mcp__buildkite__get_build(
  org: "ianremmelllc",
  pipeline: "apps",
  number: <build_number from URL>
)
```

Check annotations and failed job logs to categorize the failure:

- **Fixable**: lint errors, type errors, build failures from breaking API
  changes, test failures from updated behavior
- **Unfixable**: infrastructure failures, flaky tests unrelated to the update,
  network errors

If categorized as unfixable, skip this PR and report it as unfixable.

### 2. Create Worktree

Create a worktree from the dependabot branch (NOT main) using a fix branch:

```
FIX_BRANCH = fix-dependabot-<pr_number>-<YYYY-MM-DDTHHMMSS>
```

This is a variant of the **Create Worktree (New Branch)** operation from
`../../references/worktree.md`, but based on a dependabot branch instead of
`origin/main`:

```bash
git fetch origin <dependabot_headRefName>
mkdir -p ~/projects/worktrees/apps
git worktree add -b $FIX_BRANCH ~/projects/worktrees/apps/$FIX_BRANCH origin/<dependabot_headRefName>
```

**Sandbox note**: `git worktree add` requires `dangerouslyDisableSandbox: true`.

Set `FIX_WORKTREE_DIR` to the resulting path.

**CRITICAL — Unset tracking branch**: `git worktree add -b` sets the new branch
to track the dependabot remote branch. This means a bare `git push` will push
directly to the dependabot branch, bypassing the fix PR workflow. Immediately
after creating the worktree, unset the upstream:

```bash
cd ~/projects/worktrees/apps/$FIX_BRANCH && git branch --unset-upstream
```

This ensures all pushes must use an explicit refspec
(`git push -u origin $FIX_BRANCH`), preventing accidental pushes to the
dependabot branch.

Bootstrap with build (the fix needs to compile):

```bash
cd $FIX_WORKTREE_DIR && npm ci
cd $FIX_WORKTREE_DIR && npm run build
```

### 3. Dispatch Fix Agent

Dispatch a `senior-engineer` subagent (`run_in_background: true`) with:

- The failure analysis from step 1 (annotations, error messages, failed job
  logs)
- The `FIX_WORKTREE_DIR` absolute path
- The `FIX_BRANCH` name
- Local build error output (the build in step 2 may have also failed — include
  that output)
- Instructions to:
    1. Diagnose the root cause from the failure information
    2. Fix the issue (update types, fix tests, resolve breaking changes)
    3. Run `npm run validate` to verify the fix
    4. Commit with `fix(deps): resolve build failure from <dependency> update`
    5. Push with explicit refspec: `git push -u origin $FIX_BRANCH:$FIX_BRANCH`
       **NEVER use bare `git push`** — the branch must NOT push to the
       dependabot branch. Always specify the refspec.

### 4. Create Fix PR

After the fix agent pushes, create a PR targeting the dependabot branch:

```
mcp__github__create_pull_request(
  owner: $REPO_OWNER,
  repo: $REPO_NAME,
  head: $FIX_BRANCH,
  base: <dependabot_headRefName>,
  title: "fix(deps): resolve build failure in #<pr_number>",
  body: "## Summary

Fixes build failures in Dependabot PR #<pr_number> (<pr_title>).

### Changes
<brief description of what was fixed>

### Failure Analysis
<summary of what was failing and why>

## Test plan
- [ ] CI passes on this branch
- [ ] Dependabot PR can be merged after this fix lands"
)
```

**Note on MCP PR body formatting**: The `body` parameter must use actual newline
characters, NOT `\n` escape sequences.

Store the fix PR number in `FIX_PR_MAP[original_pr_number]`.

### 5. Simplified CI Monitoring

Monitor the fix PR's CI with a simplified loop:

- Poll every 120 seconds, max 15 polls (30 minutes)
- On success: report the fix PR as ready
- On failure: report the failure and move on (no retry)
- On timeout: report timeout and move on

### 6. Report

For each fix attempt, record:

- Original dependabot PR number and title
- Fix PR number and URL (if created)
- CI result: `success` | `failure` | `unfixable` | `timeout`
- Brief description of what was fixed (or why it couldn't be)

## Worktree Cleanup

Each fix worktree should be cleaned up after the fix PR's CI monitoring
completes (regardless of result):

Follow the **Remove Worktree** operation from `../../references/worktree.md`
with `BRANCH_NAME` = `FIX_BRANCH`.

## Error Handling

| Scenario                   | Action                             |
| -------------------------- | ---------------------------------- |
| Cannot fetch build details | Skip PR, report as uninvestigable  |
| Worktree creation fails    | Skip PR, report error              |
| Fix agent fails            | Skip PR, report what was attempted |
| Push fails                 | Retry once, then skip PR           |
| Fix PR creation fails      | Retry once, then skip PR           |
| CI timeout                 | Report timeout, clean up           |
