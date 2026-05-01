---
name: linear-project
description:
    Orchestrate the full lifecycle of an entire Linear project. Use when the
    user invokes "/linear-project <project-name>". Loads the project with
    milestones and issues, works through milestones sequentially, parallelizes
    independent issues within each milestone, and delegates each issue to the
    linear-ticket execution pattern via `/loop`-based tick monitoring. Reports
    PRs to the user for review and monitors for merge before proceeding. Between
    milestones, performs architectural review and roadmap adjustment.
---

**PLAN MODE GUARD:** If plan mode is active, do NOT proceed. Instead, tell the
user: "The linear-project skill is an orchestrator that manages subagents. It
cannot operate in plan mode — please exit plan mode and re-invoke
`/linear-project`." Then stop.

# Linear Project Lifecycle

Announce at start: "I'm using the linear-project skill to orchestrate project
`<PROJECT_NAME>`."

Parse the project name from the skill arguments. All phases below use these
shared variables:

- `PROJECT_NAME` — the Linear project name from arguments
- `PROJECT_ID` — Linear project ID (set during Phase 1)
- `REPO_OWNER` / `REPO_NAME` — extracted from `git remote get-url origin`
- `MILESTONES` — ordered list of milestone objects
- `CURRENT_MILESTONE_INDEX` — index into MILESTONES
- `PROJECT_STATE_PATH` — path to the project state JSON file on disk
  (`/tmp/claude/project-state/<PROJECT_NAME>.json`). Contains issue metadata.
  Subagents read this file on demand — the orchestrator does NOT load detailed
  data into its own context.
- `MAX_PARALLEL_ISSUES` — set to 3. Counts only issues with active agents
  (tracked via `agent-working` label and lock files in
  `/tmp/claude/project-state/locks/`).

## Phase 1: Load Project

Load and follow `references/project-loading.md`. This dispatches a subagent to
fetch all project data from Linear, assess resume state, and write a compact
JSON summary. The orchestrator reads only the summary file — all MCP tool
verbosity stays in the subagent's context.

## Phase 1.5: Post-Merge Review

Before starting milestone work, run the post-merge review protocol to catch any
deferred work from previously merged PRs that lacks follow-up tickets. This is
especially important on resume, where PRs may have been merged between sessions.

Load and follow `../references/post-merge-review.md` with:

- `REPO_OWNER` and `REPO_NAME` from the project variables

If no PRs have the `needs-followup` label, this phase completes immediately.

## Phase 2: Initialize Scheduling

No ready queue is built here. The first tick of the orchestration loop
dispatches `fetch-available-tickets` to compute unblocked issues on demand. That
subagent fetches relations for the current milestone's issues, builds a
milestone-scoped dependency graph, detects anomalies (cycles, reverse deps), and
caches the graph to disk.

Anomaly handling (cycles, reverse cross-milestone deps) occurs in the
orchestration loop after the first `fetch-available-tickets` returns — see
`references/orchestration-loop.md` tick pseudocode.

## Phase 3: Execute Milestones

For each milestone sequentially:

1. Run one initial tick manually: fetch available tickets, create worktrees and
   PRs, dispatch `ticket-worker` agents for the first batch of issues.
2. **Immediately** invoke `/loop 3m` to start the orchestration loop — do NOT
   wait for ticket-workers to complete. The `/loop` ticks handle all ongoing
   monitoring (CI status, review feedback, merge detection, slot filling) while
   ticket-workers run in the background.

**CRITICAL: You MUST start `/loop` immediately after dispatching the first
ticket-workers.** Do not manually poll agents, wait for TaskOutput, or try to
drive the monitoring yourself. The entire point of the `/loop` model is that the
orchestrator does not hold context across ticks — each tick reads state from
disk and GitHub independently.

### `/loop` Integration

The orchestration loop runs as a series of **stateless ticks** via `/loop` on a
2-5 minute interval. Each tick:

1. Reads `active-prs.json` from disk
2. Runs `orchestrate check-status` for each active PR
3. Dispatches `ticket-worker` or `pr-monitor` agents for PRs needing work
4. Handles cleanup for merged/closed PRs
5. Fills slots with new issues via `fetch-available-tickets`
6. Checks milestone completion
7. Exits — next tick starts with fresh context

This replaces the previous long-lived orchestrator loop. The key benefit is that
each tick gets fresh agent context, preventing context exhaustion during
multi-hour project runs.

### Agent Types

- **`ticket-worker`** — Handles the full implementation cycle for a single
  ticket. Dispatched when a new issue is started. Reads the implementation
  brief, creates commits, runs validation, pushes. Follows
  `../ship-pr/references/execution-loop.md`. Because that loop is now free
  of Linear logic, the `ticket-worker` dispatch (see
  `references/orchestration-loop.md` "Dispatching ticket-worker") must own
  the Linear-specific hooks explicitly: Ticket Progress Update Protocol
  seeding at start, sub-issue creation for deferred items in `## Decisions`
  on merge, and ticket status move-to-Done on merge.

- **`pr-monitor`** — Monitors a single PR through CI failures and review
  feedback. Dispatched when an existing PR needs attention (CI failure,
  review feedback). Follows `.claude/agents/pr-monitor.md`. Because
  `pr-monitor` no longer updates Linear itself, the tick must apply the
  move-to-Done hook when `check-status` reports the PR as merged — this is
  already covered in `references/orchestration-loop.md` "Handling Merged
  PRs".

### Context Management

Each tick reads state from disk and GitHub, not from accumulated context:

| State              | Source                                            |
| ------------------ | ------------------------------------------------- |
| Active PRs         | `/tmp/claude/project-state/active-prs.json`       |
| Agent activity     | Lock files + `agent-working` label                |
| PR CI/review state | `orchestrate check-status` (GitHub API)           |
| Issue results      | `/tmp/claude/issue-status/<ID>.json`              |
| Milestone history  | `/tmp/claude/project-state/milestone-<name>.json` |

**CRITICAL: DO NOT merge pull requests.** Report to user when PRs are ready for
review. Monitor for merge. Clean up and move on after merge.

**CRITICAL: PR SIZE LIMIT.** Every PR must stay under 500-800 lines of
new/changed code (excluding lockfiles and generated files). Test files count
toward the budget. When dispatching `ticket-worker` agents, include this
constraint explicitly in their brief. If a ticket would produce more than 800
lines, the agent should implement only the core functionality and report what
was deferred. The orchestrator creates follow-up tickets for deferred work.

## Phase 4: Milestone Review

Between milestones (except after the last):

1. Read the milestone summary from
   `/tmp/claude/project-state/milestone-<name>.json` (written by the final tick
   of the milestone — see "Milestone Boundary Compression" in
   `references/orchestration-loop.md`).

2. Load and follow `references/milestone-review.md`.

3. Dispatch `staff-engineer` for architectural review, then `pragmatic-pm` for
   roadmap adjustment. Report recommendations to user. Major changes require
   user confirmation. Minor changes apply automatically.

4. After review: `git fetch origin main` to pick up merged work.

The milestone summary provides compressed context so the review agents do not
need to re-read all PR data from GitHub.

## Phase 5: Project Completion

Report final summary: all milestones and outcomes, all PR URLs, failed/skipped
issues, architectural notes. Read milestone summaries from disk to compile the
report without re-fetching from GitHub.

## Error Handling

| Scenario                        | Action                                         |
| ------------------------------- | ---------------------------------------------- |
| Project not found               | Retry 3x, then stop                            |
| No milestones                   | Treat all issues as one synthetic milestone    |
| Dependency cycle                | Report cycle, ask user which edge to break     |
| Issue implementation fails      | Mark failed, continue with others              |
| Blocker failed -> dependent     | Mark dependent as skipped, report              |
| >50% of milestone issues failed | Pause, ask user whether to continue            |
| CI fails 3 times for an issue   | Mark failed, report, continue with others      |
| No progress for 2 hours         | Escalate with full status report               |
| PR closed without merge         | Mark failed, report, unblock nothing           |
| Agent stale (lock > 60min)      | Remove lock/label, re-evaluate on next tick    |
| `/tmp` wiped                    | Rebuild from GitHub/Linear, see state recovery |

## Resume Behavior

Re-running `/linear-project <project-name>` resumes an interrupted session. The
`/loop` tick model makes resume natural: state is always read from disk and
GitHub, never from in-memory data.

### What Persists Across Interruptions

- **Worktrees** on disk at `~/projects/worktrees/apps/<branch-name>`
- **PRs** on GitHub (draft or ready, open or merged)
- **Linear ticket states** in Linear
- **Git branches** on the remote
- **Milestone summaries** in `/tmp/claude/project-state/` (if `/tmp` survives)
- **`active-prs.json`** in `/tmp/claude/project-state/` (if `/tmp` survives)

### What Is Lost

- Running agents (killed when conversation ends)
- Lock files in `/tmp/claude/project-state/locks/` (agents presumed dead)
- Status files in `/tmp/claude/issue-status/` (ephemeral)
- Cached milestone graphs (ephemeral, rebuilt on demand by
  `fetch-available-tickets`)

### State Recovery (after `/tmp` wipe)

If `/tmp` is lost, all state is recoverable from GitHub and Linear:

1. **`active-prs.json`**: Rebuilt from
   `gh pr list --state open --author @me --json number,headRefName`
2. **Lock files**: Missing locks = no agents running. Next tick dispatches
   agents as needed.
3. **PR progress**: Read from `clc-progress` block in PR body via
   `orchestrate check-status`
4. **Linear ticket state**: Always authoritative via
   `mcp__linear-server__get_issue`
5. **Milestone summaries**: Can be reconstructed from `git log` and merged PR
   data, though with less detail than the original summaries.

### Practical Usage

If a conversation is interrupted mid-project, start a new conversation and run:

```
/linear-project <same-project-name>
```

The orchestrator will:

- Detect already-merged PRs and mark those issues `done`
- Detect in-progress PRs and resume monitoring (CI, reviews, merge)
- Detect draft PRs with implementation and resume from CI monitoring
- Start fresh work only on issues with no existing artifacts
