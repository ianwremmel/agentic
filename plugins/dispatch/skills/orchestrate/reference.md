# orchestrate — reference

Lookup tables for [`SKILL.md`](./SKILL.md).

## Reconcile

For each active coordinator, judge by its `outcome.json` if present, else by
liveness. **Cleanup** = remove `<cache>/work-ticket/<key>/` and any mirrored
"working" label; the coordinator already owns its ticket's role transitions.

| Signal                                            | Do                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `verified` · `canceled`                           | Cleanup; drop.                                                                                         |
| `delivered`                                       | Ticket-backed: dispatch the verification pass — a fresh coordinator run for the same ticket, reusing the artifact's claim id — then cleanup. Bare PR: terminal — cleanup; drop. |
| `human-blocked`                                   | Cleanup; the parked ticket is tick step 5's.                                                           |
| `decomposed`                                      | Keep `outcome.json` — it *is* the deferred-finalization record. Dispatch a finalization coordinator once the doc shows every subtask `verified`/`canceled`; cleanup then. |
| `failed`, verification, `retryable: true`         | Re-dispatch next tick reusing the artifact's id; cleanup after dispatch.                               |
| `failed`, otherwise                               | Keep `outcome.json` as the parked record — deleting it would route the ticket down the no-outcome re-dispatch row; `ERROR` log + surface to the operator; no auto-re-dispatch. |
| no outcome; node terminal / bare PR closed        | Cleanup; drop.                                                                                         |
| no outcome; claim stale (ticket) / lock stale or absent (bare PR) | Presumed dead: re-dispatch with a fresh agent id — its claim reclaims the stale one.   |
| no outcome; claim live                            | Nothing this tick.                                                                                     |

Live coordinators = in-flight nodes with `claim-live="true"` plus bare-PR dirs
with a fresh `lock.json`.

## Dispatch inputs

A coordinator gets identifiers and hints, never ticket content:

- ticket-backed: `ticket_id`, `ticket_url`, `target-kind`, any `branch-hint`,
  the claim agent id, and that it is **dispatched** (outcome artifact +
  heartbeat expected). The id comes from `next --claim` on first dispatch; a
  re-dispatch off an outcome artifact **reuses** the exited run's id (its claim
  refreshes instantly); only a presumed-dead re-dispatch (stale claim, no
  outcome) mints a fresh id and reclaims. Finalization and verification re-dispatches also say which pass
  this is.
- bare PR: `repo`, `pr_number`, `pr_url`, `branch`; key `<repo>#<n>`.
- both: identity/mode context, forwarded to every `deliver`.

## Milestone-review agent

Dispatched per ready-unreviewed milestone; tracked by a sentinel
`<cache>/orchestrate/reviews/<milestone>.json`
`{ "milestone", "project", "agent_id", "heartbeat" }` the agent heartbeats.
Stale sentinel without a recorded review → re-dispatch. The brief:

1. Read the milestone's tickets and their DoD artifacts from the tracker.
2. Answer: was the milestone goal achieved, and is follow-up work needed?
3. File any follow-ups in the **current** milestone (they re-block advancement
   through the graph; no orchestrator action needed).
4. Record the outcome as a comment on the milestone's review artifact (Linear:
   a project update; GitHub: a milestone closure comment) in wire format. Any
   human input is solicited as comments on that same artifact, tagging a human
   — never the session — and the outcome is not recorded until it resolves.
5. Final action: `dispatch graph record-review --id <milestone>`.

## Human alerts

One per human-blocked ticket, as a ticket comment: leading
`<!-- agent-reply:dispatch -->` marker, then (inside the body, after any Mode B
sparkle) the sentinel `<!-- agent-human-alert:dispatch -->`, then what is
needed, why an agent cannot do it, and a request to move the ticket back to an
available state when done. Scan the ticket's comments for the sentinel first;
an alert is resolved when a human has responded with addressable content.

## Injection inbox

One JSON file per item in `<cache>/orchestrate/inbox/`:

- ticket: `{ "kind": "ticket", "id": "DEV-123", "tracker": "linear" }` — fetched
  and written `--injected` by the next refresh, then the file is deleted.
- PR: `{ "kind": "pr", "repo": "o/r", "pr_number": 7, "pr_url": "…",
  "branch": "…" }` — moved to `<cache>/work-ticket/<repo>#<n>/injected.json`
  when its coordinator is dispatched, so a crash before an outcome still leaves
  a re-dispatchable record.

## Cadence

Never tick faster than once per minute.

| Situation                                         | Tick every |
| ------------------------------------------------- | ---------- |
| Free capacity and dispatchable work likely        | 1–2 min    |
| All capacity live (coordinators computing)        | 5 min      |
| Only waits remain (humans, reviews, external CI)  | 15–30 min  |
