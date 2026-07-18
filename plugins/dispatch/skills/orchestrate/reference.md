# orchestrate — reference

Lookup tables for [`SKILL.md`](./SKILL.md).

## Dispatch inputs

A coordinator gets identifiers and hints, never ticket content:

- from the `fill` output's `<ticket>` element: the item id (a `<repo>#<n>` id
  is a bare PR), `url`, `target-kind`, any `branch-hint`, any `pass`, and
  `agent` — the CLI-minted claim id the coordinator heartbeats and reports
  under;
- that it is **dispatched** (final report via `dispatch graph outcome set`
  expected).

A `pass` scopes the run: `resume` — pick up a crashed run's item (re-derive
its state from the ticket and PRs); `verify` — validate the aims and post the
DoD (the PRs already landed); `finalize` — verify a decomposed parent now that
its subtasks resolved; `retry` — re-run a failed verification.

## Milestone-review agent

The brief is the [`milestone-review`](../milestone-review/SKILL.md) skill —
dispatch a subagent running it; never inline the review yourself. Hand it: the
`milestone` and `project` from the fill `<review>` element, its `agent` id (it
heartbeats and releases under it), and that it is **dispatched**.

Its lock is the milestone's claim: `record-review` releases it on success; the
agent releases it explicitly when the gate must stay closed (follow-ups
filed). A stale claim with no recorded review is re-emitted by a later `fill`
under a fresh id (the claim reclaims).

## Human alerts

One per ticket awaiting a human (a `<human-blocked>` park or a surfaced
`<failures>` entry), as a ticket comment: leading
`<!-- agent-reply:dispatch -->` marker, then (inside the body, after the
sparkle when credentials are shared) the sentinel
`<!-- agent-human-alert:dispatch -->`, then what is
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
