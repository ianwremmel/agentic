---
name: linear-ticket
description:
    Orchestrate the full lifecycle of a Linear ticket. Use when the user invokes
    "/linear-ticket <TICKET-ID>" or asks to work on a Linear ticket end-to-end.
    Fetches branch name from Linear, creates a worktree, opens a draft PR via
    the `create-pr` skill, drives the PR to completion via the `ship-pr`
    skill, then applies Linear-specific post-merge hooks (sub-issue creation
    for deferred work, ticket status update, ticket progress update).
---

# Linear Ticket Lifecycle

Announce at start: "I'm using the linear-ticket skill to orchestrate work on
ticket <TICKET-ID>."

Parse the ticket ID from the skill arguments. All phases below use these shared
variables:

- `TICKET_ID` — the Linear ticket ID from arguments (e.g., `CLC-123`)
- `WORKTREE_DIR` — set during Phase 2
- `BRANCH_NAME` — set during Phase 1
- `PR_NUMBER` — set during Phase 3
- `REPO_OWNER` / `REPO_NAME` — extracted from `git remote get-url origin`
- `TICKET_URL` — the `url` field from the Linear API response (used for PR body
  link)

Prefix all Bash commands with `cd $WORKTREE_DIR &&` after Phase 2 completes,
since Bash cwd does not persist between tool calls.

## Phase 1: Validate & Fetch

1. Validate `TICKET_ID` matches `^[A-Z]+-[0-9]+$`. If invalid, explain the
   expected format and stop.

2. Fetch ticket from Linear using `mcp__linear-server__get_issue` with the
   ticket ID. Extract:
    - `gitBranchName` — the branch name Linear generates
    - `title` — ticket title (for PR title)
    - `description` — full ticket body (for implementation context)
    - `identifier` — the ticket ID (e.g., `CLC-123`)
    - `url` — the Linear ticket URL (store as `TICKET_URL`)

    If the call fails, retry up to 3 times with 5-second delays.

3. Generate a unique branch name by appending an ISO timestamp:

    ```
    BRANCH_NAME = <gitBranchName>-<YYYY-MM-DDTHHMMSS>
    ```

4. Extract repository owner and name from the git remote:
    ```bash
    git remote get-url origin | sed -E 's|.*[:/]([^/]+)/([^/.]+)(\.git)?$|\1 \2|'
    ```
    Set `REPO_OWNER` and `REPO_NAME` from the two words in the output.

## Phase 2: Worktree Creation

Follow the **Create Worktree (New Branch)** and **Bootstrap Worktree**
operations from `../references/worktree.md`:

- `BRANCH_NAME` = the branch name generated in Phase 1
- `BASE_REF` = `origin/main`
- `SKIP_BUILD` = false

Set `WORKTREE_DIR` to the resulting worktree path.

## Phase 3: Draft PR

Invoke the `create-pr` skill with these inputs:

- `WORKTREE_DIR`
- `BRANCH_NAME`
- `TICKET_ID`
- `TICKET_URL`

The skill returns `PR_NUMBER` and `PR_URL`.

After `create-pr` returns, update the Linear ticket description to seed the
`## Agent Progress` entry for this PR by following the **Ticket Progress
Update Protocol** below with `status: open`.

## PR Size Constraint

**CRITICAL**: Every PR must stay under 500-800 lines of new/changed code
(excluding lockfiles and generated files). Test files count toward the budget.
When dispatching the implementation sub-agent, include this constraint
explicitly in the brief. If the ticket would produce more than 800 lines,
implement only the core functionality and note what was deferred.

## Phase 4: Ship the PR

Set the shared execution loop variables:

- `COMMIT_SCOPE` — the conventional commit scope, determined by the package(s)
  being modified (e.g., `nx`, `merge-dependabot`). Per convention:
  `feat(package-name): description`. For cross-cutting changes that span many
  packages, the scope may be omitted.
- `IMPLEMENTATION_BRIEF` = the full Linear ticket description fetched in Phase 1

Invoke the `ship-pr` skill with all shared variables. The skill returns a
`result` (`approved` | `merged` | `closed` | `escalated`) and a parsed list
of deferred items from the PR body's `## Decisions` section.

### Post-ship hooks (Linear-specific)

After `ship-pr` returns, apply the following Linear-specific hooks based on
the result:

1. **For every result except `escalated`**, update the ticket's
   `## Agent Progress` entry for `PR_NUMBER` by following the **Ticket
   Progress Update Protocol** below. Map `ship-pr` results to the canonical
   status vocabulary as follows:

    | `ship-pr` result | Ticket progress `status` |
    | ---------------- | ------------------------ |
    | `approved`       | `open` (still unmerged)  |
    | `merged`         | `merged`                 |
    | `closed`         | `closed`                 |

2. **If `result == merged`**:

    a. **Create follow-up Linear sub-issues for deferred work.** For each
    item in the deferred list returned by `ship-pr`, create a sub-issue via
    `mcp__linear-server__save_issue` with:
    - A clear title describing the deferred work
    - Description referencing the parent ticket and PR
    - `parentId: $TICKET_ID`

    Record each created ticket URL in the PR's `## Decisions` section next
    to the deferred item (`gh pr edit $PR_NUMBER --body-file <tmpfile>`).
    Preserve the `<!-- clc-progress -->` block when updating the body.

    **Do NOT say "filed as a known gap" or "deferred to a follow-up" without
    creating a real Linear ticket.** Every deferred item must have a
    corresponding sub-issue.

    b. **MANDATORY** — Update the Linear ticket status to "Done". Look up
    the team's "Done" state ID via `mcp__linear-server__list_issue_statuses`,
    then call
    `mcp__linear-server__save_issue(id: $TICKET_ID, stateId: <done_state_id>)`.
    Retry up to 3 times on failure.

    c. Update `## Agent Progress` to mark PR `$PR_NUMBER` as `merged`.

3. **If `result == closed`**, inspect the PR body's `## Decisions` section
   for any prerequisite entries recorded by the Prerequisite Discovery
   protocol. If present, create a blocking sub-issue via
   `mcp__linear-server__save_issue` with a clear title and a note that it
   blocks `TICKET_ID`, then move `$TICKET_ID` back to the team's "Backlog"
   or "Todo" state via `mcp__linear-server__list_issue_statuses` +
   `mcp__linear-server__save_issue`.

## Phase 5: Cleanup

Once the PR is merged or closed, the skill's work is done.

1. Follow the **Remove Worktree** operation from `../references/worktree.md`.

2. Report to the user:
    - The PR URL and branch name for reference
    - That the worktree has been cleaned up
    - Any follow-up sub-issues that were created

## Ticket Progress Update Protocol

This protocol tracks cross-PR progress on the Linear ticket description. It
only applies when `TICKET_ID` is set (it always is for this skill).

### Reading Ticket Progress

1. Fetch the ticket via `mcp__linear-server__get_issue` (already done during
   Phase 1).
2. Extract the YAML block between `<!-- clc-ticket-progress` and `-->` from
   the description.
3. Parse to understand what was completed in previous PRs and what remains.

### Writing Ticket Progress

1. Read the current ticket description via `mcp__linear-server__get_issue`.
2. If no progress section exists, append a separator (`---`) and
   `## Agent Progress` heading.
3. Add or update the PR entry under `## Agent Progress`.
4. Update the `<!-- clc-ticket-progress -->` block with structured data.
5. Write back via `mcp__linear-server__save_issue`.

### Canonical Status Vocabulary

The ticket-progress `status` field for each PR entry is one of exactly:

- `open` — PR exists and is not in a terminal state (includes draft, ready,
  under review, and approved-but-not-yet-merged). This is also the value
  written when `ship-pr` returns `approved` — the PR is approved but still
  unmerged, so from the ticket's perspective it is still "open".
- `merged` — PR reached a terminal merged state.
- `closed` — PR reached a terminal closed-without-merge state.

The human-readable heading next to each PR mirrors the same vocabulary
(e.g., `### PR #123 (merged)` / `(open)` / `(closed)`).

### Ticket Progress Format (human-readable)

```markdown
---

## Agent Progress

### PR #123 (merged)

- Implemented core endpoint and unit tests
- Deferred: error recovery logic, retry middleware

### PR #456 (open)

- Working on error recovery logic

<!-- clc-ticket-progress
prs:
  - number: 123
    status: merged
    completed: ["core endpoint", "unit tests"]
    deferred: ["error recovery", "retry middleware"]
  - number: 456
    status: open
    completed: []
    deferred: []
remaining: ["error recovery", "retry middleware"]
-->
```

### When to Update

- On PR creation (add new PR entry with `status: open`)
- On ship-pr returning with deferred items (record what was completed and
  deferred)
- On PR merge (mark `status: merged`)
- On PR close-without-merge (mark `status: closed`)

## Error Handling

| Scenario                         | Action                                   |
| -------------------------------- | ---------------------------------------- |
| Invalid ticket ID format         | Stop, explain expected format            |
| Linear MCP fails                 | Retry 3 times with 5s delay, then stop   |
| `gitBranchName` is empty         | Ask user for a branch name               |
| `git worktree add` fails         | Stop, ask user for guidance              |
| `npm ci` / `npm run build` fails | Warn, continue                           |
| `git push` fails                 | Retry once (GitHub flaky), then ask user |
| `gh pr create` fails             | Retry once, then ask user                |
| CI timeout (30 min)              | Report status, ask user                  |
| 3 CI fix attempts fail           | Report what was tried, ask user          |
