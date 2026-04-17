---
name: merge-dependabot
description:
    Merge all passing Dependabot PRs into a single combined branch. Creates a
    worktree, merges passing PRs, resolves conflicts, fixes build failures, and
    follows the shared execution loop for CI monitoring and review. Invoke with
    "/merge-dependabot" (no arguments needed).
---

**PLAN MODE GUARD:** If plan mode is active, do NOT proceed. Instead, tell the
user: "The merge-dependabot skill is an orchestrator that manages subagents. It
cannot operate in plan mode — please exit plan mode and re-invoke
`/merge-dependabot`." Then stop.

# Merge Dependabot PRs

Announce at start: "I'm using the merge-dependabot skill to combine passing
Dependabot PRs into a single update."

This skill has no arguments. All phases below use these shared variables:

- `BRANCH_NAME` — generated in Phase 2
- `WORKTREE_DIR` — set during Phase 2
- `PR_NUMBER` — set during Phase 4
- `REPO_OWNER` / `REPO_NAME` — extracted from `git remote get-url origin`
- `COMMIT_SCOPE` — hardcoded to `deps`
- `CANDIDATE_PRS` — passing Dependabot PRs identified in Phase 1
- `MERGED_PRS` — PRs successfully merged in Phase 3
- `SKIPPED_PRS` — PRs skipped due to conflicts in Phase 3
- `FAILING_PRS` — PRs with failing CI in Phase 1 (excluding those with existing
  fix attempts)
- `PENDING_PRS` — PRs with pending CI in Phase 1
- `ALREADY_ATTEMPTED_PRS` — failing PRs skipped because an open fix PR already
  targets their branch
- `FIX_PRS` — subset of `FAILING_PRS` selected for fix attempts (max 3)
- `FIX_PR_STATE` — map of original PR number to fix state (`investigating` |
  `fixing` | `ci_monitoring` | `done` | `failed`)
- `FIX_PR_MAP` — map of original PR number to fix PR number

No `TICKET_ID` or `TICKET_URL` — this skill has no Linear ticket.

Prefix all Bash commands with `cd $WORKTREE_DIR &&` after Phase 2 completes,
since Bash cwd does not persist between tool calls.

## Phase 1: Discovery

1. Extract `REPO_OWNER`/`REPO_NAME` from the git remote:

    ```bash
    git remote get-url origin | sed -E 's|.*[:/]([^/]+)/([^/.]+)(\.git)?$|\1 \2|'
    ```

    Set `REPO_OWNER` and `REPO_NAME` from the two words in the output.

2. List open Dependabot PRs:

    ```bash
    gh pr list --author "app/dependabot" --state open \
      --json number,title,headRefName,headRefOid --limit 100
    ```

3. For each PR, check the combined CI status:

    ```bash
    gh api repos/$REPO_OWNER/$REPO_NAME/commits/<headRefOid>/status --jq '.state'
    ```

    Categorize each PR:
    - `success` → add to `CANDIDATE_PRS`
    - `failure` or `error` → add to `FAILING_PRS`
    - `pending` → add to `PENDING_PRS`

4. For each PR in `FAILING_PRS`, check for existing open fix PRs targeting that
   branch:

    ```bash
    gh pr list --base <headRefName> --state open \
      --json number,title,headRefName --limit 10
    ```

    If any open PRs are returned, move the failing PR from `FAILING_PRS` to
    `ALREADY_ATTEMPTED_PRS`, recording the fix PR number(s).

5. Report discovery to user:

    ```
    Found N Dependabot PRs:
    - M passing: #1 title, #2 title ...
    - P failing (no existing fix): #4 title ... (will attempt fixes for up to 3)
    - R already being fixed: #7 title (fix PR #42 is open) ...
    - Q pending: #6 title ... (skipped)

    Proceeding to merge M passing PRs.
    Will attempt to fix up to 3 failing PRs in parallel.
    ```

    Select up to 3 of the oldest failing PRs (by PR number, after removing
    already-attempted ones) and store them in `FIX_PRS`. Initialize
    `FIX_PR_STATE` for each.

6. If zero passing PRs, stop and report.

7. Auto-proceed — announce the list and continue immediately (no confirmation
   wait).

## Phase 2: Worktree Creation

1. Generate a branch name with an ISO timestamp:

    ```
    BRANCH_NAME = chore-merge-dependabot-<YYYY-MM-DDTHHMMSS>
    ```

2. Follow the **Create Worktree (New Branch)** and **Bootstrap Worktree**
   operations from `../references/worktree.md`:
    - `BASE_REF` = `origin/main`
    - `SKIP_BUILD` = true (build happens after merges in Phase 3)

## Phase 3: Merge & Fix

Load `references/merge-and-fix.md` for the detailed merge algorithm.

Summary: merge each candidate PR in order (oldest first by PR number), handle
conflicts, run `npm install && npm run build`, and fix any build failures.

## Phase 4: Draft PR

1. Push the branch:

    ```bash
    cd $WORKTREE_DIR && git push -u origin $BRANCH_NAME
    ```

    Retry once on failure — GitHub is known to be flaky.

2. Create a draft PR:

    ```bash
    cd $WORKTREE_DIR && gh pr create --draft \
      --title "chore(deps): merge $(echo $MERGED_PRS | wc -l) dependabot updates" \
      --body "$(cat <<'EOF'
    ## Summary

    Combined the following Dependabot PRs into a single update:

    ### Merged PRs
    <for each PR in MERGED_PRS>
    - #<number> <title>
    </for each>

    ### Skipped PRs (merge conflicts with source files)
    <for each PR in SKIPPED_PRS>
    - #<number> <title> — <reason>
    </for each>
    <or "None" if empty>

    ### Not included (failing/pending CI)
    <for each PR in FAILING_PRS + PENDING_PRS>
    - #<number> <title> — <CI status>
    </for each>
    <or "None" if empty>

    ## Test plan
    - [ ] All merged dependency updates build successfully
    - [ ] Unit tests pass
    - [ ] Lint passes

    ## Progress
    - [x] Implementation
    - [ ] CI passing (attempt 0/3)
    - [ ] Code review requested
    - [ ] Review feedback addressed (cycle 0/5)
    - [ ] Merged

    <!-- clc-progress
    phase: monitoring
    ci_fix_attempts: 0
    review_cycles: 0
    implementation_complete: true
    commit_scope: deps
    last_updated: <current ISO 8601 timestamp>
    watermark_review_id: 0
    watermark_comment_id: 0
    watermark_issue_comment_id: 0
    -->
    EOF
    )"
    ```

    Store the PR number from the output as `PR_NUMBER`.

## Phase 4.5: Fix Failing PRs

If `FIX_PRS` is non-empty, load `references/fix-failing-prs.md` and begin fix
attempts in the background.

This phase runs **in parallel** with Phase 5 (CI monitoring and review of the
merge PR). The orchestrator monitors both tracks:

- **Track 1**: The merge PR's CI and review cycle (Phase 5)
- **Track 2**: Fix PR creation and CI monitoring (Phase 4.5)

Dispatch fix attempts for each PR in `FIX_PRS` following the algorithm in
`references/fix-failing-prs.md`. Track progress via `FIX_PR_STATE`.

The orchestrator's polling loop (during Phase 5) should also check on fix PR
agents and CI status, updating `FIX_PR_STATE` as results come in.

## Phase 5: Execute

Set `COMMIT_SCOPE = deps` and `IMPLEMENTATION_BRIEF` to a note that
implementation is not needed (merging was done in Phase 3).

Load and follow `../ship-pr/references/execution-loop.md` starting from the
**Monitoring Step** (skip Implementation — merging was Phase 3). No
Linear-specific post-ship hooks are needed — this skill has no `TICKET_ID`,
so the default ship-pr flow is correct end to end.

## Phase 6: Cleanup

After the PR is merged (detected during review monitoring):

1. Do NOT manually close the original Dependabot PRs. Dependabot automatically
   closes its PRs when it detects the version bumps are already on the default
   branch after the combined PR merges.

2. Follow the **Remove Worktree** operation from `../references/worktree.md`.

3. Report to the user:
    - The PR URL and final status
    - List of merged Dependabot PRs (will auto-close after merge)
    - Any skipped PRs that still need individual attention
    - Already-attempted PRs: for each entry in `ALREADY_ATTEMPTED_PRS`, the
      dependabot PR number/title and the existing fix PR number(s)
    - Fix PR results:
        - For each entry in `FIX_PR_MAP`: the fix PR URL and CI result
        - For failed/unfixable PRs: what was attempted and why it didn't work

4. Clean up fix worktrees: for each fix branch in `FIX_PR_MAP`, follow the
   **Remove Worktree** operation from `../references/worktree.md`.

If the PR is not yet merged when the skill completes (e.g., review monitoring
timed out), provide the user with:

- The PR URL
- Instructions that they can use `/resume #<PR_NUMBER>` to pick up monitoring

## Error Handling

| Scenario                        | Action                                   |
| ------------------------------- | ---------------------------------------- |
| Zero passing Dependabot PRs     | Report and stop                          |
| All PRs have merge conflicts    | Report, clean up worktree, stop          |
| `npm install` fails after merge | Dispatch senior-engineer to fix (max 3)  |
| `npm run build` fails           | Dispatch senior-engineer to fix (max 3)  |
| `git push` fails                | Retry once (GitHub flaky), then ask user |
| `gh pr create` fails            | Retry once, then ask user                |
| CI timeout (30 min)             | Report status, ask user                  |
| 3 CI fix attempts fail          | Report what was tried, ask user          |
| Fix agent cannot diagnose       | Skip that PR, report as unfixable        |
| Fix PR CI fails                 | Report failure, do not retry             |
