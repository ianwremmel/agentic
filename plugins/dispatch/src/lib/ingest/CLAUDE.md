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
  instruction kinds. A scan reads everything and maps every status before it
  writes anything, so an unmappable state costs a half-written graph nothing.

The writes go through the same stores the CLI commands use, so the native path
and the agent path leave the graph in the same state. Two places they differ on
purpose:

- A scan declares milestone membership, blockers, and the milestone chain. The
  ticket instructions write the ticket row only — a ticket materialized to
  satisfy somebody else's dependency would otherwise chase the graph out of the
  projects that were asked for.
- The cursor reported back is when the scan started, not the newest `updatedAt`
  it saw. An issue edited while the scan pages can land behind a page already
  read.
