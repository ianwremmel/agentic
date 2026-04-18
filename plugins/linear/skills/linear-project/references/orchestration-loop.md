# Orchestration Loop: `/loop`-Based Tick Model for Milestone Execution

This is the core loop that drives all issues in a milestone through their
lifecycle. It uses a **stateless tick model**: each tick reads state from disk
and GitHub, takes action on PRs that need attention, and exits. The next tick
starts with fresh context.

## Architecture

The orchestration loop is driven by `/loop` on a 2-5 minute interval. Each tick
is a fresh agent invocation that:

1. Reads `active-prs.json` from disk
2. Runs `orchestrate check-status` for each active PR
3. Dispatches agents for PRs that need work
4. Handles cleanup for merged/closed PRs
5. Exits

Long-lived agents (`ticket-worker`, `pr-monitor`) handle implementation and
monitoring within a single PR. The orchestrator itself never accumulates context
across ticks.

**Hybrid model**:

- `/loop` drives the outer monitoring loop (check all active PRs, dispatch work)
- Long-lived agents handle implementation and CI/review monitoring within a
  single PR
- Each `/loop` tick reads state from `orchestrate` scripts and disk files, not
  from accumulated context

## Prerequisites

Before entering this loop, the following must be set:

- `MILESTONES` — the full ordered list of milestones
- `CURRENT_MILESTONE_INDEX` — which milestone we're executing
- `REPO_OWNER`, `REPO_NAME`
- `PROJECT_STATE_PATH` — path to the project state JSON file on disk
  (`/tmp/claude/project-state/<PROJECT_NAME>.json`). Contains issue metadata.
  Subagents read this file on demand — the orchestrator does NOT load detailed
  data into its own context.
- `MAX_PARALLEL_ISSUES` — set to 3. Counts only issues with active agents
  (tracked via `agent-working` label and lock files).

## State Persistence

All state lives on disk or in GitHub — never in agent memory:

| State                | Location                                           | Access method                 |
| -------------------- | -------------------------------------------------- | ----------------------------- |
| Active PRs           | `/tmp/claude/project-state/active-prs.json`        | Read/write from tick          |
| Agent locks          | `/tmp/claude/project-state/locks/<pr_number>.json` | File mtime for staleness      |
| PR progress          | PR body (`clc-progress` block)                     | `orchestrate progress`        |
| PR labels            | GitHub labels                                      | `orchestrate label`           |
| PR CI/review status  | GitHub API                                         | `orchestrate check-status`    |
| Issue status results | `/tmp/claude/issue-status/<issue identifier>.json` | Read by tick after agent      |
| Milestone summary    | `/tmp/claude/project-state/milestone-<name>.json`  | Written at milestone boundary |

## `active-prs.json` Schema

Path: `/tmp/claude/project-state/active-prs.json`

```json
[
    {
        "pr_number": 123,
        "branch_name": "clc-100-feat-something-2026-03-15T120000",
        "worktree_dir": "/root/projects/worktrees/apps/clc-100-feat-something-2026-03-15T120000",
        "ticket_id": "CLC-100",
        "ticket_url": "https://linear.app/code-like-a-carpenter/issue/CLC-100/feat-something"
    }
]
```

Written by the tick when a new PR is created (via `orchestrate start-pr`).
Updated by the tick when PRs are merged or closed (entry removed). All writes
use the atomic pattern: write to `.tmp` sibling, then `mv` into place.

## Lock File Protocol

Lock files track which PRs have active agents to prevent duplicate dispatches.

**Location**: `/tmp/claude/project-state/locks/<pr_number>.json`

**Created by**: The tick, immediately before dispatching an agent.

**Heartbeat**: The dispatched agent updates the file's mtime every 10 minutes
via `touch /tmp/claude/project-state/locks/<pr_number>.json`.

**Staleness**: Determined by the lock file's **mtime** (not a JSON field).
Staleness threshold is **60 minutes** — this accommodates CI builds (15-25
minutes) plus fix cycles. If the lock file's mtime is older than 60 minutes, the
agent is presumed dead.

**Cleanup**: The dispatched agent deletes the lock file on exit (both success
and failure paths). If the agent crashes without cleanup, the next tick detects
staleness and removes the lock.

**Label synchronization**: The `agent-working` GitHub label mirrors the lock
file. If a lock exists but the label does not (agent removed label but crashed
before deleting lock), the lock is cleaned up. If the label exists but the lock
does not (partial state loss), the label is removed.

## Status File Protocol

Sub-agents communicate results to the orchestrator via small status files rather
than through transcript reads. This prevents context exhaustion from absorbing
full agent output.

**Location**: `/tmp/claude/issue-status/<issue identifier>.json`

**Format**:

```json
{
    "state": "pushed" | "merged" | "approved" | "closed" | "escalated" | "failed",
    "summary": "Brief description of what was done",
    "commit_scope": "package-name",
    "error": "Description of failure (only present when state is failed)"
}
```

The orchestrator reads ONLY this file — never the full sub-agent output via
`TaskOutput`. If the status file is missing when the sub-agent has completed,
the orchestrator treats this as a failure and reports to the user.

Sub-agents MUST write this file as their final action before completing.

## Tick Pseudocode

```
active_prs = read /tmp/claude/project-state/active-prs.json
if file missing or empty: active_prs = []

# --- Reconcile orphaned lock files ---
# Use file staleness (>60 min) as the source of truth for whether an
# agent is presumed dead.  Delete stale locks unconditionally based on
# mtime so they no longer count toward MAX_PARALLEL_ISSUES, then do a
# best-effort cleanup of any stuck agent-working labels.
for each lock_file in /tmp/claude/project-state/locks/*.json:
    pr_number = parse lock_file name
    lock_age = now() - file_mtime(lock_file)
    if lock_age < 60 minutes:
        continue  # Lock is fresh; agent may still be running

    # Stale lock: agent presumed dead — always delete the lock file
    # regardless of label state.  Use rm -f to tolerate concurrent
    # deletion by another tick or agent cleanup.
    rm -f lock_file

    # Best-effort label cleanup: remove a stuck agent-working label,
    # but do not resurrect or retain the lock if this fails.
    label_names = gh pr view $pr_number --json labels --jq '.labels[].name' \
        || { log warning "failed to read labels for PR $pr_number; leaving labels as-is"; continue }
    if "agent-working" in label_names:
        orchestrate label remove $pr_number agent-working \
            || { log warning "failed to remove agent-working label for PR $pr_number"; continue }

for each pr in active_prs:
    # --- Per-PR error isolation ---
    # Each PR is processed independently. If check-status fails for one PR
    # (GitHub API outage, rate limiting), log the error and skip to the next
    # PR. One PR's failure must not starve the rest.
    status = orchestrate check-status $pr.pr_number || { log error; continue }

    # --- Agent lifecycle: prevent duplicate dispatches ---
    if "agent-working" in status.labels:
        lock = read /tmp/claude/project-state/locks/$pr.pr_number.json
        if lock does not exist:
            # Label exists but lock file missing (partial state loss)
            orchestrate label remove $pr.pr_number agent-working
        elif file_mtime(lock) > 60 minutes ago:
            # Agent presumed dead — staleness threshold exceeded
            orchestrate label remove $pr.pr_number agent-working
            rm lock file
        else:
            continue  # Agent still working, lock is fresh — skip this PR

    # --- Handle terminal states ---
    if status.merged:
        handle_merged(pr)  # See "Handling Merged PRs" below
        continue

    if status.closed:
        handle_closed(pr)  # See "Handling Closed PRs" below
        continue

    # --- Handle PRs needing work ---
    if status.has_feedback:
        write lock file: /tmp/claude/project-state/locks/$pr.pr_number.json
        orchestrate label add $pr.pr_number agent-working
        dispatch pr-monitor agent (pr)  # See "Dispatching pr-monitor" below
        continue

    if status.ci_state == "failure" and not status.has_feedback:
        write lock file: /tmp/claude/project-state/locks/$pr.pr_number.json
        orchestrate label add $pr.pr_number agent-working
        dispatch pr-monitor agent (pr)  # pr-monitor handles CI fix cycles
        continue

    # --- Handle unresolved Copilot feedback ---
    # copilot_clean:false means Copilot has unresolved comments.
    # TRUST THIS FLAG — do not second-guess it with GitHub API queries.
    # (Copilot inline comments come from user "Copilot", not
    # "copilot-pull-request-reviewer[bot]" — querying by the wrong
    # username returns empty results and causes false negatives.)
    if not status.copilot_clean and status.ci_state != "failure" and not status.has_feedback:
        write lock file: /tmp/claude/project-state/locks/$pr.pr_number.json
        orchestrate label add $pr.pr_number agent-working
        dispatch pr-monitor agent (pr)  # pr-monitor addresses Copilot comments
        continue

    # --- Handle review lifecycle ---
    if status.needs_copilot_request:
        orchestrate review copilot --force $pr.pr_number
        continue

    # Only request human review when BOTH CI is passing AND Copilot is
    # clean.  Requesting review while CI is pending or failing wastes
    # the reviewer's time — the code may still change.
    if status.ci_state == "success" and status.copilot_clean and status.approval_state != "APPROVED":
        orchestrate review human $pr.pr_number
        continue

# --- Fill slots: start new issues ---
# Count PRs with active agents (lock files exist and are not stale)
active_agent_count = count of non-stale lock files
slots_to_fill = MAX_PARALLEL_ISSUES - active_agent_count

if slots_to_fill > 0:
    dispatch fetch-available-tickets subagent
    # See "Starting New Issues" below for the full protocol
    for each ticket in available_tickets:
        if slots filled: break
        start_issue(ticket)

# --- Check milestone completion ---
milestone_issues = issues in current milestone
if all milestone_issues have terminal status (merged/closed/failed/skipped):
    write milestone summary to disk  # See "Milestone Boundary Compression"
    break  # Milestone complete — exit tick, SKILL.md advances to next

# --- Write updated active-prs.json (atomic) ---
write active_prs to /tmp/claude/project-state/active-prs.json.tmp
mv active-prs.json.tmp active-prs.json
```

## Starting New Issues

When a slot is available and `fetch-available-tickets` returns work:

1. Generate branch name: `<issue.gitBranchName>-<YYYY-MM-DDTHHMMSS>`
2. Create worktree via `../../references/worktree.md` (Create Worktree +
   Bootstrap)
3. Create PR via
   `orchestrate start-pr <worktree_dir> --ticket-id <ID> --ticket-url <URL>`
    - Returns JSON: `{pr_number, pr_url, branch_name}`
4. Add PR entry to `active-prs.json`
5. Write lock file for the PR
6. Add `agent-working` label
7. Dispatch `ticket-worker` agent — see "Dispatching ticket-worker" below
8. Report to user: "Starting work on <identifier>: <title>"

## Dispatching ticket-worker

The `ticket-worker` agent handles the full implementation cycle for a single
ticket: TDD implementation, code review, fixes, validation, and push.

Dispatch with `run_in_background: true`:

> Read and follow `../ship-pr/references/execution-loop.md` from the
> Implementation Step through the Completion Step.
>
> Variables:
>
> - `IMPLEMENTATION_BRIEF` = <issue's full description>
> - `WORKTREE_DIR` = <absolute path>
> - `BRANCH_NAME` = <branch name>
> - `PR_NUMBER` = <pr number>
> - `REPO_OWNER` = <value>
> - `REPO_NAME` = <value>
> - `TICKET_ID` = <issue identifier>
> - `TICKET_URL` = <issue url>
>
> `TICKET_ID` and `TICKET_URL` are not consumed by ship-pr itself (which is
> Linear-free), but the ticket-worker uses them directly when running the
> Linear-specific hooks below.
>
> Linear-specific responsibilities (the ship-pr execution loop is Linear-free,
> so the ticket-worker owns these hooks directly):
>
> - Before starting implementation, seed the Linear ticket's `## Agent Progress`
>   entry for `<pr_number>` with `status: open` by following the Ticket Progress
>   Update Protocol in `../linear-ticket/SKILL.md`.
> - At the Completion Step, record any deferred work under `## Decisions` in the
>   PR body, but do **not** create Linear sub-issues yet. Sub-issue creation
>   happens on merge so that follow-ups are not filed for PRs that end up closed
>   without merging (matching `.claude/skills/linear-project/SKILL.md`).
> - On reaching a terminal `merged` state:
>     - For each deferred item recorded in the PR body's `## Decisions` section,
>       create a Linear sub-issue via `mcp__linear-server__save_issue` with
>       `parentId: <issue identifier>`, and record the sub-issue URL next to the
>       deferred item in the PR body (preserving the `<!-- clc-progress -->`
>       block).
>     - Update the Linear ticket to "Done" via
>       `mcp__linear-server__list_issue_statuses` +
>       `mcp__linear-server__save_issue`, retrying up to 3 times on failure.
>     - Update the ticket's `## Agent Progress` entry to mark the PR as
>       `status: merged` via the Ticket Progress Update Protocol in
>       `../linear-ticket/SKILL.md`.
> - On reaching a terminal `closed` state, do not create any sub-issues; update
>   the ticket's `## Agent Progress` entry to mark the PR as `status: closed`.
>
> Constraints:
>
> - Write status file on completion:
>   `/tmp/claude/issue-status/<issue identifier>.json`
> - Keep PR under 500-800 lines of new/changed code (excluding lockfiles and
>   generated files). Test files count. If exceeding, implement core only and
>   note deferrals.
> - Use `Grep` (not rg/grep), `Read` (not cat), `Edit`/`Write` (not
>   sed/awk/heredocs) for file operations.
> - Do NOT edit any `package.json` files directly.
> - Heartbeat: `touch /tmp/claude/project-state/locks/<pr_number>.json` every 10
>   minutes.
> - On exit (success or failure): remove lock file, remove `agent-working` label
>   via `orchestrate label remove <pr_number> agent-working`.

## Dispatching pr-monitor

The `pr-monitor` agent monitors a single PR through CI failures and review
feedback. It reads poll results, classifies feedback, dispatches fix subagents,
and manages reactions.

Dispatch the `pr-monitor` agent (definition at `.claude/agents/pr-monitor.md`)
with `run_in_background: true`:

> Variables:
>
> - `WORKTREE_DIR` = <worktree path from active-prs.json>
> - `BRANCH_NAME` = <branch name from active-prs.json>
> - `PR_NUMBER` = <pr number>
> - `REPO_OWNER` = <value>
> - `REPO_NAME` = <value>
> - `COMMIT_SCOPE` = <from PR progress block or status file>
>
> Constraints:
>
> - Write status file on completion:
>   `/tmp/claude/issue-status/<issue identifier>.json` with terminal state
>   (`approved` | `merged` | `closed` | `escalated`)
> - Heartbeat: `touch /tmp/claude/project-state/locks/<pr_number>.json` every 10
>   minutes.
> - On exit (success or failure): remove lock file, remove `agent-working` label
>   via `orchestrate label remove <pr_number> agent-working`.
>
> `pr-monitor` is Linear-free. The tick applies the Linear move-to-Done hook
> when it later processes the merged PR via "Handling Merged PRs" below.

## Handling Merged PRs

When `orchestrate check-status` reports `merged: true`:

1. Remove PR entry from `active-prs.json`
2. Clean up lock file if present:
   `rm -f /tmp/claude/project-state/locks/<pr_number>.json`
3. Remove `agent-working` label if present
4. Update PR progress:
    - `phase`: `done`
    - Check "Merged" in checklist
5. Update Linear ticket to "Done":
    - Look up team's "Done" state ID via
      `mcp__linear-server__list_issue_statuses`
    - Call `mcp__linear-server__save_issue(id: identifier, stateId: <done_id>)`
    - Retry up to 3 times on failure
6. Follow the **Remove Worktree** operation from `../../references/worktree.md`
7. Clean up status file:
   `rm -f /tmp/claude/issue-status/<issue identifier>.json`
8. Report: "PR #<N> for <identifier> merged. <remaining> issues left."

## Handling Closed PRs

When `orchestrate check-status` reports `closed: true`:

1. Check PR comments for prerequisite closure (comments mentioning "requires"
   and a Linear ticket ID like `CLC-\d+`):
    - If prerequisite closure: the ticket remains available for future pickup
      after the prerequisite is done. Do NOT mark as failed.
    - If not prerequisite: mark as failed in Linear.
2. Remove PR entry from `active-prs.json`
3. Clean up lock file and label
4. Follow **Remove Worktree** from `../../references/worktree.md`
5. Clean up status file
6. Report closure reason to user

## Failure Escalation

- If more than 50% of issues in the current milestone are failed/skipped, pause
  and ask the user whether to continue to the next milestone or stop.
- Individual failures are reported but do not halt the milestone.

### How dependents of failed issues are skipped

The tick does NOT read the dependency graph directly. Failure propagation
happens through `fetch-available-tickets`:

1. Issue A fails
2. Next tick passes A in `FAILED_IDS` to `fetch-available-tickets`
3. Subagent identifies all issues whose blockers include A
4. Those issues appear in `permanently_blocked`
5. The tick marks them as skipped
6. Transitive cascade across subsequent ticks

## Milestone Boundary Compression

At each milestone boundary, write a compressed summary to disk. This enables
future ticks and milestone reviews to understand history without loading full
context.

**Path**: `/tmp/claude/project-state/milestone-<name>.json`

```json
{
    "milestone": "M1: Foundation Scripts",
    "done": ["CLC-100", "CLC-101", "CLC-102"],
    "failed": ["CLC-103"],
    "skipped": ["CLC-104"],
    "pr_urls": {
        "CLC-100": "https://github.com/owner/repo/pull/100",
        "CLC-101": "https://github.com/owner/repo/pull/101",
        "CLC-102": "https://github.com/owner/repo/pull/102"
    },
    "architectural_notes": [
        "Established orchestrate script pattern",
        "CLC-103 failed due to upstream API change — created follow-up"
    ]
}
```

The milestone review (see `milestone-review.md`) reads this file instead of
reconstructing history from GitHub. Each tick can also read previous milestone
summaries to understand what was done without loading full PR data.

## State Recovery

If `/tmp` is wiped (machine restart, worktree loss), state is recoverable from
GitHub:

1. **Rebuild `active-prs.json`**:

    ```bash
    gh pr list --state open --author @me --json number,headRefName
    ```

    Match branch names against known project issues to reconstruct entries.

2. **Rebuild lock state**: No lock files means no agents running. All PRs will
   be checked on the next tick and agents dispatched as needed.

3. **Read PR progress**: `orchestrate check-status` reads CI state, labels, and
   review status directly from GitHub. The `clc-progress` block in the PR body
   preserves counters (ci_fix_attempts, review_cycles).

4. **Linear ticket state**: Always authoritative — read via
   `mcp__linear-server__get_issue`.

The tick model makes recovery simple: since no tick holds state across
invocations, a fresh tick after state loss simply reads what GitHub and Linear
know, and resumes from there.

## Tick Lifecycle Summary

```
/loop tick starts (fresh context)
  |
  +-- Read active-prs.json
  |
  +-- For each PR:
  |     +-- orchestrate check-status
  |     +-- Skip if agent-working (with fresh lock)
  |     +-- Handle merged/closed (cleanup, remove from list)
  |     +-- Dispatch pr-monitor if needs work (feedback, CI failure)
  |     +-- Request reviews if needed (copilot, human)
  |
  +-- Fill slots with new issues (fetch-available-tickets)
  |     +-- Create worktree, PR, dispatch ticket-worker
  |
  +-- Check milestone completion
  |     +-- If complete: write milestone summary, exit
  |
  +-- Write updated active-prs.json (atomic)
  |
  +-- Exit (context released)
```
