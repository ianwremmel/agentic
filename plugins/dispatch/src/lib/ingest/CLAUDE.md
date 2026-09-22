# ingest

Answers a fetch instruction in the server instead of pushing it to an agent.
`lib/linear` reads the workspace; this turns what it read into graph writes and
speaks dispatch's vocabulary — statuses, projects, milestones, edges.

- `native.mts` — `canAnswerNatively` (tracker plus credentials) and
  `answerNatively`, which returns `false` for anything it did not answer so the
  drain pushes the instruction instead. Every failure lands there, deliberately:
  an unreachable Linear, and a workflow state no table maps, are both things the
  build-graph agent can still do something about.
- `linear-status.mts` — one Linear workflow state as a dispatch status. Names
  decide the `started` and `unstarted` groups, which hold several roles each;
  every other group decides itself.
- `linear-ingest.mts` — `ingestLinearScan` and `ingestLinearTicket`, the two
  instruction kinds. A scan reads and maps every issue in its delta before it
  writes anything, so an unmappable state costs a half-written graph nothing.
  Each write is its own transaction, so a failure in the write phase does leave
  what came before it committed.

The writes go through the same stores the CLI commands use. Where the two paths
differ they differ on purpose:

- A scan declares milestone membership and blockers. The ticket instructions
  write the ticket row only — a ticket materialized to satisfy somebody else's
  dependency would otherwise chase the graph out of the projects that were asked
  for.
- Membership and a cleared priority are *replaced*, not added to. `edge add` and
  `ticket set --priority` can only add and set, so the agent path leaves a
  ticket moved between milestones in both, and keeps a priority Linear cleared.
- The cursor reported back is when the scan started, less a clock-skew
  allowance, not the newest `updatedAt` it saw. An issue edited while the scan
  pages can land behind a page already read.

Two things the scan does not do, both of which the agent path does not do
either: it never removes a ticket that left the project (`listIssueIdentifiers`
is the read that would find them), and it only adds milestone-chain edges, so
reordering milestones in Linear leaves the old order behind and the next scan
fails on the cycle.
