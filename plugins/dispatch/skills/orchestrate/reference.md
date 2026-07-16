# orchestrate — reference

Lookup tables for [`SKILL.md`](./SKILL.md).

## Dispatch inputs

A coordinator gets identifiers and hints, never ticket content:

- from the `next --claim` output: the item id (a `<repo>#<n>` id is a bare PR),
  `url`, `target-kind`, any `branch-hint`, any `pass`;
- the claim agent id you minted — the coordinator heartbeats and reports under
  it;
- that it is **dispatched** (final report via `dispatch graph outcome set`
  expected), plus the identity/mode context it forwards to every `deliver`.

A `pass` scopes the run: `resume` — pick up a crashed run's item (re-derive
its state from the ticket and PRs); `verify` — validate the aims and post the
DoD (the PRs already landed); `finalize` — verify a decomposed parent now that
its subtasks resolved; `retry` — re-run a failed verification.

## Milestone-review agent

Its lock is the milestone's claim: heartbeat with `dispatch graph heartbeat
--id <milestone> --agent <id>`; `record-review` releases it. A stale claim
with no recorded review is re-dispatched under a fresh id (the claim
reclaims). The brief:

1. Read the milestone's tickets and their DoD artifacts from the tracker.
2. Answer: was the milestone goal achieved, and is follow-up work needed?
3. File any follow-ups in the **current** milestone (they re-block advancement
   through the graph; no orchestrator action needed).
4. Record the outcome as a comment on the milestone's review artifact (Linear:
   a project update; GitHub: a milestone closure comment) in wire format. Any
   human input is solicited as comments on that same artifact, tagging a human
   — never the session — and the outcome is not recorded until it resolves.
5. Final action: `dispatch graph record-review --id <milestone>`. If it
   refuses because the milestone regained open work (a follow-up already
   reached the graph), that is the finished state: release the claim
   (`dispatch graph release --id <milestone> --agent <id>`) and exit — the
   gate stays closed, and a fresh review runs when the milestone re-completes.

## Human alerts

One per human-blocked ticket, as a ticket comment: leading
`<!-- agent-reply:dispatch -->` marker, then (inside the body, after any Mode B
sparkle) the sentinel `<!-- agent-human-alert:dispatch -->`, then what is
needed, why an agent cannot do it, and a request to move the ticket back to an
available state when done. Scan the ticket's comments for the sentinel first;
an alert is resolved when a human has responded with addressable content. When
a ticket resumes with no reply (the role just moved), terminal-tag your own
alert (react 👍) so a later park can post a fresh one.

## Cadence

One tick per `/loop` firing; let it self-pace within these bounds, never faster
than once per minute.

| Situation                                        | Tick every |
| ------------------------------------------------ | ---------- |
| Free slots and a non-empty queue likely          | 1–2 min    |
| All slots held (coordinators computing)          | 5 min      |
| Only waits remain (humans, reviews, external CI) | 15–30 min  |
