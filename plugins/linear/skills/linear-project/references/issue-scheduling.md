# Issue Scheduling: On-Demand Scheduling

The dependency graph is built lazily by the `fetch-available-tickets` subagent
on a per-milestone basis, rather than being computed upfront by
`fetch-project-overview`. The graph is cached at
`/tmp/claude/project-state/<PROJECT_NAME>.graph.<MILESTONE_ID>.json` so
subsequent invocations reuse it without re-fetching relations from Linear. The
orchestrator does NOT load the graph into its own context. Instead, scheduling
decisions are delegated to the `fetch-available-tickets` subagent, which builds
or reads the cached graph on demand.

## On-Demand Scheduling

There is no persistent `ready_queue` in the orchestrator's context. When the
orchestrator has open implementation slots, it dispatches a
`fetch-available-tickets` subagent (see `fetch-available-tickets.md`), which:

1. Reads or builds the milestone-scoped dependency graph (cached per milestone)
2. Computes which issues are unblocked (using `DONE_IDS` and `FAILED_IDS` from
   the orchestrator — only `DONE_IDS` satisfy blockers; `FAILED_IDS` permanently
   block dependents)
3. Identifies permanently blocked issues (dependents of failed blockers)
4. Ranks unblocked issues by: resumed first, then priority, then downstream
   impact
5. Returns full ticket details for the top N candidates, plus a
   `permanently_blocked` array for the orchestrator to mark as skipped

This keeps the graph out of the orchestrator's context entirely.

## Blocked-by-failure propagation

When an issue transitions to `failed`, the orchestrator does NOT read the
dependency graph itself. Instead, failure propagation is handled by
`fetch-available-tickets`:

1. The orchestrator passes the failed issue in `FAILED_IDS` on the next Fill
   Slots call
2. The subagent reads the graph and identifies all issues (in any milestone)
   whose blockers include any `FAILED_IDS` entry
3. These issues are returned in the `permanently_blocked` output array with
   their failed blocker identifiers
4. The orchestrator marks them as `skipped` with reason: "Blockers <identifiers>
   failed" (listing all failed blockers from the entry)
5. On subsequent calls, the newly-skipped issues are also in `FAILED_IDS`,
   causing transitive propagation across multiple Fill Slots passes

This handles both intra-milestone and cross-milestone dependents without the
orchestrator ever loading the dependency graph.

## Scheduling Constraints

- `MAX_PARALLEL_ISSUES = 3` -- maximum concurrent issues with active sub-agents
  (states: setup, implementing, validating)
- Issues in polling-only states (ci_monitoring, ready_for_review,
  monitoring_reviews, waiting_for_merge) do NOT count against this limit — the
  orchestrator handles polling inline with minimal context consumption. This
  means new implementation work starts immediately when a sub-agent completes
  and pushes, without waiting for CI or reviews on other issues.
- Scheduling order is determined by `fetch-available-tickets` ranking:
    1. Resumed issues first (existing worktree/PR)
    2. By Linear priority (1=urgent ... 4=low, 0=no priority sorts last)
    3. By downstream impact (issues that unblock the most work go first)
