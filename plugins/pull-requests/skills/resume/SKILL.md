---
name: resume
description:
    Resume work on an existing PR, Linear ticket, or ad-hoc branch. Resolves the
    current state from a ticket ID, PR number, or branch name, then picks up the
    execution loop from the appropriate step. Invoke with "/resume <identifier>"
    where identifier is a Linear ticket ID (CLC-123), PR number (#456 or 456),
    or branch name.
---

# Resume Lifecycle

Announce at start: "I'm using the resume skill to pick up work on <identifier>."

Parse the identifier from the skill arguments. It can be one of:

- A Linear ticket ID matching `^[A-Z]+-[0-9]+$`
- A PR number matching `^#?\d+$`
- A branch name (anything else)

## Phase R1: Resolve Identifiers

Starting from whatever identifier was given, resolve all shared variables by
cross-referencing multiple sources. The goal is to populate:

- `TICKET_ID` (null for ad-hoc work)
- `BRANCH_NAME`
- `WORKTREE_DIR`
- `PR_NUMBER`
- `REPO_OWNER` / `REPO_NAME`
- `TICKET_URL` (null for ad-hoc work)
- `IMPLEMENTATION_BRIEF`

Use `scripts/orchestrate find-worktree <identifier>` to locate or create the
worktree. The command returns JSON:

```json
{"worktree_dir": "...", "branch_name": "...", "found": true|false, "created": true|false}
```

Set `WORKTREE_DIR` and `BRANCH_NAME` from the result.

### From a Linear Ticket ID

1. Fetch the ticket from Linear using `mcp__linear-server__get_issue`. Extract
   `gitBranchName`, `title`, `description`, `identifier`, and `url` (->
   `TICKET_URL`).

    If the ticket description contains a `<!-- clc-ticket-progress` block,
    extract it to understand what was completed in previous PRs. This context
    will be included in the `IMPLEMENTATION_BRIEF` so the implementing agent
    knows what's already done and focuses on remaining work.

2. Run `scripts/orchestrate find-worktree <ticket_id>` to locate or create the
   worktree. If the result has `found: false` and `created: false`, try again
   with `scripts/orchestrate find-worktree <gitBranchName>`.
3. Search for an existing PR on a matching branch:

    ```bash
    gh pr list --head "$BRANCH_NAME" --json number,headRefName --jq '.[0]'
    ```

    If found, set `PR_NUMBER`.

4. Set `IMPLEMENTATION_BRIEF` from the full Linear ticket description (including
   any `## Agent Progress` section).

### From a PR Number

1. Strip any leading `#` from the identifier and set `PR_NUMBER`.
2. Run `scripts/orchestrate find-worktree <pr_number>` to resolve the branch and
   locate or create the worktree.
3. Fetch the PR details:

    ```bash
    gh pr view $PR_NUMBER --json headRefName,title,body
    ```

    Extract `BRANCH_NAME` from `headRefName` (confirm it matches the
    find-worktree result).

4. Extract `TICKET_ID` from the PR title or body (look for pattern
   `[A-Z]+-[0-9]+` in the title scope or body).
5. **If `TICKET_ID` found**: fetch the ticket from Linear to get `TICKET_URL`
   and full description. Set `IMPLEMENTATION_BRIEF` from the ticket description.

    If the ticket description contains a `<!-- clc-ticket-progress` block,
    extract it to understand what was completed in previous PRs.

6. **If `TICKET_ID` not found (ad-hoc work)**: set `TICKET_ID = null` and
   `TICKET_URL = null`. Set `IMPLEMENTATION_BRIEF` from the PR body's
   `## Summary` section, or if no summary section exists, from the full PR body.

### From a Branch Name

1. Set `BRANCH_NAME` directly.
2. Run `scripts/orchestrate find-worktree <branch_name>` to locate or create the
   worktree.
3. Search for an existing PR:

    ```bash
    gh pr list --head "$BRANCH_NAME" --json number --jq '.[0].number'
    ```

4. Extract `TICKET_ID` from the branch name (look for `[A-Z]+-[0-9]+` pattern).
5. **If `TICKET_ID` found**: fetch from Linear for `TICKET_URL` and description.
   Set `IMPLEMENTATION_BRIEF` from the ticket description.

    If the ticket description contains a `<!-- clc-ticket-progress` block,
    extract it to understand what was completed in previous PRs.

6. **If `TICKET_ID` not found (ad-hoc work)**: set `TICKET_ID = null` and
   `TICKET_URL = null`. If a PR exists, set `IMPLEMENTATION_BRIEF` from the PR
   body's `## Summary` section. If no PR exists, ask the user to describe the
   work to be done and use their response as `IMPLEMENTATION_BRIEF`.

### Extract Repo Info

```bash
git remote get-url origin | sed -E 's|.*[:/]([^/]+)/([^/.]+)(\.git)?$|\1 \2|'
```

Set `REPO_OWNER` and `REPO_NAME` from the output.

### Validation

If `BRANCH_NAME` and `WORKTREE_DIR` cannot be resolved, report what was found
and what's missing, and ask the user for guidance.

- If no worktree, no PR, and a ticket ID was given, suggest using
  `/linear-ticket` instead to start fresh.
- If no worktree, no PR, and no ticket ID (ad-hoc), suggest starting fresh with
  a new branch.

## Phase R2: Assess Current State

### Step 0: Read PR Progress

If `PR_NUMBER` is set, read progress via
`scripts/orchestrate progress read $PR_NUMBER`. Parse the YAML output. If
present, use its fields to:

- **Set the entry point** directly from the `phase` field instead of running the
  heuristic checks below:
    - `implementation` (with `implementation_complete: false`) ->
      **Implementation Step**
    - `implementation` (with `implementation_complete: true`) or `pre_push` ->
      **Pre-push Validation Step**
    - `monitoring` -> **Monitoring Step** (derive `completion_done` from PR
      draft status: if PR is ready for review, completion was already done)
    - `ci_monitoring` -> `monitoring` with completion_done=false (backward
      compat)
    - `review_monitoring` -> `monitoring` with completion_done=true (backward
      compat)
    - `completion` -> `monitoring` with completion_done=false (completion will
      re-run)
    - `done` -> Cleanup only
- **Restore `COMMIT_SCOPE`** from the progress block's `commit_scope` field so
  the resumed loop reuses the original conventional-commit scope without
  re-deriving it. **Do not** copy `ci_fix_attempts`, `review_cycles`, or any
  `watermark_*` fields into shell variables — `ship-pr`/`pr-monitor` read those
  exclusively from the `<!-- clc-progress -->` block. If you need to override a
  counter or watermark before resuming (e.g., reset `ci_fix_attempts` to 0 after
  a manual fix), write the new value into the progress block with
  `scripts/orchestrate progress write $PR_NUMBER <field>=<value>` — do not try
  to pass it through as a direct variable.
- **Read the `## Decisions` section** for implementation context

If NO progress block is present, fall through to the heuristic assessment below
(steps 1-9) as a backward-compatible fallback for PRs created before progress
tracking was added.

Check conditions in order and determine which step of the execution loop to
enter:

1. **No worktree exists?** Follow the **Create Worktree (Existing Remote
   Branch)** and **Bootstrap Worktree** operations from
   `../references/worktree.md`. -> Enter execution loop at **Implementation
   Step**

2. **No PR exists?** A worktree exists but no PR was created yet. Invoke the
   `create-pr` skill to open a draft PR, then: -> Enter execution loop at
   **Implementation Step**

3. **PR is draft with only the initial empty commit?**

    ```bash
    cd $WORKTREE_DIR && git log --oneline origin/main..HEAD | wc -l
    ```

    If only 1 commit (the empty initial commit): -> Enter execution loop at
    **Implementation Step**

4. **PR is draft with implementation commits?** The PR has substantive commits
   but is still a draft. Implementation is done (or partially done), so skip to
   monitoring: -> Enter execution loop at **Monitoring Step** (with
   completion_done=false)

5. **CI failing on latest commit?** Check the latest commit status:

    ```bash
    gh api repos/$REPO_OWNER/$REPO_NAME/commits/$(cd $WORKTREE_DIR && git rev-parse HEAD)/statuses \
      --jq '[.[] | select(.context | contains("buildkite"))] | sort_by(.updated_at) | last'
    ```

    If status indicates failure: -> Enter execution loop at **Monitoring Step**
    (with completion_done=false; will investigate and fix)

6. **Outstanding change requests on the PR?**

    ```bash
    gh pr view $PR_NUMBER --json reviewDecision --jq '.reviewDecision'
    ```

    If `CHANGES_REQUESTED`: -> Enter execution loop at **Monitoring Step** (with
    completion_done=true)

7. **CI passing, no reviews yet?** PR is ready but hasn't been reviewed: ->
   Enter execution loop at **Monitoring Step** (with completion_done=false;
   completion will run when CI success is detected)

8. **PR is approved?** -> Proceed to cleanup (Phase R3 merges and cleans up)

9. **PR is already merged?** -> Skip to worktree cleanup only

## Phase R3: Resume

1. Report the assessed state to the user:

    ```
    Resuming work on $BRANCH_NAME:
    - Branch: $BRANCH_NAME
    - Worktree: $WORKTREE_DIR
    - PR: #$PR_NUMBER
    - Ticket: $TICKET_ID (or "ad-hoc, no ticket")
    - State: <from progress block phase, or heuristic assessment>
    - CI fix attempts used: <ci_fix_attempts from progress block>/3
    - Review cycles used: <review_cycles from progress block>/5
    - Last progress update: <last_updated from progress block, or "unknown">
    - Entering execution loop at: <step name>
    ```

2. Ensure dependencies are current in the worktree:

    ```bash
    cd $WORKTREE_DIR && npm ci && npm run build
    ```

3. Set the shared execution loop variables:
    - `COMMIT_SCOPE` -- from the progress block if available, otherwise
      determined by the package(s) being modified
    - `IMPLEMENTATION_BRIEF` = the Linear ticket description (if ticket-based),
      the PR summary (if ad-hoc with PR), or the user's description (if ad-hoc
      without PR). If the ticket description contains a `## Agent Progress`
      section (from the Ticket Progress Update Protocol), include it in the
      brief so the implementing agent understands what was already completed in
      previous PRs and focuses on remaining work.

    CI fix attempts, review cycles, and review watermarks are NOT passed as
    direct variables. `ship-pr`/`pr-monitor` read these exclusively from the PR
    body's `<!-- clc-progress -->` block. The block already contains the
    last-known values from the previous session, so the default path is to do
    nothing. If you need to override (e.g., reset a counter before resuming),
    write the desired value into the progress block **before** entering the
    loop:

    ```bash
    cd $WORKTREE_DIR && scripts/orchestrate progress write "$PR_NUMBER" \
      ci_fix_attempts=0 review_cycles=0
    ```

4. Load and follow `../ship-pr/references/execution-loop.md` starting from the
   determined step.

5. **After the execution loop returns**, apply Linear-specific post-ship hooks
   only when `TICKET_ID` is set. When `TICKET_ID` is null (ad-hoc work), skip
   this entire block — the ship-pr execution loop is already free of Linear
   logic, so the ad-hoc path is trivially correct.

### Post-ship hooks (only when `TICKET_ID` is set)

After the execution loop returns, read the final PR body's `## Decisions`
section to extract any deferred items, then:

a. **If the loop returned `merged`**:

    1. **Create follow-up Linear sub-issues for deferred work.** For each
       item listed as deferred in `## Decisions`, create a sub-issue via
       `mcp__linear-server__save_issue` with a clear title, a description
       referencing the parent ticket and PR, and `parentId: $TICKET_ID`.
       Record each created ticket URL in the PR `## Decisions` section
       next to the deferred item (preserve the `<!-- clc-progress -->`
       block when editing the body).

       **Do NOT say "filed as a known gap" or "deferred to a follow-up"
       without creating a real Linear ticket.** Every deferred item must
       have a corresponding sub-issue.

    2. **MANDATORY** — Update the Linear ticket status to "Done". Look up
       the team's "Done" state ID via
       `mcp__linear-server__list_issue_statuses`, then call
       `mcp__linear-server__save_issue(id: $TICKET_ID, stateId: <done_state_id>)`.
       Retry up to 3 times on failure.

    3. Update the ticket's `## Agent Progress` entry for `$PR_NUMBER` to
       mark `status: merged` by following the **Ticket Progress Update
       Protocol** in `../linear-ticket/SKILL.md`.

b. **If the loop returned `closed`**, inspect the PR body's `## Decisions`
section for any prerequisite entries recorded by the Prerequisite Discovery
protocol in `ship-pr`. If present, create a blocking sub-issue via
`mcp__linear-server__save_issue` with a clear title and a note that it blocks
`$TICKET_ID`, then move `$TICKET_ID` back to the team's "Backlog" or "Todo"
state via `mcp__linear-server__list_issue_statuses` +
`mcp__linear-server__save_issue`. Then update the ticket's `## Agent Progress`
entry for `$PR_NUMBER` to mark `status: closed` by following the **Ticket
Progress Update Protocol** in `../linear-ticket/SKILL.md`.

c. **For every other terminal result** (e.g., `approved` — the PR was approved
but not yet merged), update the ticket's `## Agent Progress` entry for
`$PR_NUMBER` to mark `status: open` by following the **Ticket Progress Update
Protocol** in `../linear-ticket/SKILL.md`. The canonical status vocabulary is
`open | merged | closed`; approved PRs stay `open` until they are merged or
closed.

## Ad-hoc Work (No Ticket)

When `TICKET_ID` is null, the ship-pr execution loop is already Linear-free, so
no special handling is required beyond the normal behaviors:

- **Commit scope**: Derive from the package(s) being modified, not from a ticket
  ID.
- **PR title**: Use `<type>(<scope>): <description>` without a ticket ID
  reference.
- **Deferred work**: Listed in the PR body's `## Decisions` section only — no
  Linear sub-issues are created because there is no parent ticket.

## Ad-hoc Branch Naming Convention

When creating new branches for ad-hoc work (no ticket), use the format:

```
adhoc_<slug>_<YYYY_MM_DDTHHMMSS>
```

Rules:

- Use **underscores only** -- no hyphens or slashes
- `<slug>` is a short lowercase description of the work (underscores for spaces)
- Example: `adhoc_fix_flaky_test_2026_03_16T140000`

## Error Handling

| Scenario                                        | Action                                                  |
| ----------------------------------------------- | ------------------------------------------------------- |
| Identifier doesn't match any format             | Explain expected formats and stop                       |
| Linear ticket not found                         | Stop, suggest checking the ticket ID                    |
| No worktree and no PR found (ticket)            | Suggest using `/linear-ticket` to start fresh           |
| No worktree and no PR found (ad-hoc)            | Suggest starting fresh with a new ad-hoc branch         |
| Multiple worktrees match                        | List them and ask user to specify                       |
| Worktree exists but branch is gone from remote  | Push from worktree to recreate remote branch            |
| PR was closed (not merged)                      | Ask user if they want to reopen or start fresh          |
| find-worktree returns found=false created=false | No local or remote worktree; follow "No worktree" logic |
