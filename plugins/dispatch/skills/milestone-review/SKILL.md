---
name: milestone-review
description: Review one completed milestone — judge its goal against the tickets' DoD artifacts, file follow-ups into the same milestone, record the outcome on the tracker's review artifact, and open the gate to the next milestone. Use when a milestone is ready for review, standalone (/milestone-review <milestone>) or dispatched by an orchestrator.
---

# milestone-review

Review one **milestone** and open (or hold) the gate between it and the next.
The review answers two questions — *was the milestone goal achieved?* and *is
follow-up work needed?* — and ends in one write that matters:
`dispatch graph record-review`, which unblocks the work gated behind the
milestone. You do not own tickets ([`work-ticket`](../work-ticket/SKILL.md)
does), the graph, ranking, or dispatch
([`orchestrate`](../orchestrate/SKILL.md) does), and you never write code — a
review holds no compute slot.

**Operator** = the human directing this run. Wire format (machine marker +
Mode A/B wrapper): [`deliver/reference.md`](../deliver/reference.md).

## Inputs

The milestone id and its project. Dispatched: the orchestrator also hands the
claim agent id and identity/mode context. Standalone: mint
`review-<milestone>-<epoch>` yourself.

You are bound by the **communication restriction**: human input routes through
the review artifact (below), never by soliciting or blocking on session input.
Status to the session is fine; standalone, also report the outcome there.

## Tracker adapter

Resolve and load the `tracker-adapter-<id>` skill exactly as
[`work-ticket`](../work-ticket/SKILL.md#tracker) does (URL shape, then id
shape, then `${user_config.tracker}`; most specific same-id skill wins,
wholesale). You read its Identity, Operations, Quirks, and **Review artifact**
sections — the last names the venue that holds a review outcome and its
comment thread. With no adapter, best effort: drive the tracker's native MCP
server, pick a venue attached to the milestone (or its project) that can hold
the outcome and a comment thread, and log an `INFO` naming your choice.

## Claim

The milestone's claim is your lock — take it before reading anything:
`dispatch graph claim --id <milestone> --agent <agent-id>`.

- `claimed` / `refreshed` → proceed.
- `reclaimed` → sanctioned takeover of a dead run. Scan the review-artifact
  venue for this episode's sentinel (below) first: an artifact that already
  records the outcome for the current member set only needs the
  `record-review`; anything less, review afresh.
- `held` (exit 3) → another review is live; stop.
- not claimable (exit 4) → the milestone is not ready-unreviewed, or the graph
  doesn't know it. Standalone: refresh the graph
  ([`build-graph`](../build-graph/SKILL.md)) and retry once; still refused →
  nothing to review, report and stop. Dispatched: the graph moved under the
  dispatch; report and exit.

Heartbeat while you hold it — `dispatch graph heartbeat --id <milestone>
--agent <agent-id>` at least every few minutes, folded into any wait.
`record-review` releases the claim; when the gate must stay closed instead,
release it explicitly (`dispatch graph release --id <milestone> --agent
<agent-id>`). Never exit holding it — a stale claim reads as a crash and gets
re-dispatched.

## The review

1. **Members** — the milestone's tickets from the graph (`dispatch graph doc`,
   nodes with this milestone's id). Every member is already `verified` or
   `canceled` — that is what made the milestone ready.
2. **Evidence** — through the adapter: the milestone's goal (its description),
   each `verified` member's DoD comment (what was verified, how, what was
   deferred), each `canceled` member's rationale.
3. **Judge** — was the goal achieved, and is follow-up work needed? A DoD's
   deferred items already have follow-up tickets; what you are looking for is
   the gaps *between* tickets — an aim the milestone promised that no ticket
   delivered or deferred-with-a-ticket, or member evidence that contradicts
   the goal.

## Follow-ups — the gate stays closed

File each follow-up in the **current** milestone through the adapter, and
write it into the graph in the same pass — `dispatch graph task set --id <id>
--project <project> --milestone <milestone> --role available` (plus any
`edge add`) — so the gate holds before the next refresh. Record what you found
and filed on the review artifact (sentinel and wire format as below, verdict
"follow-ups filed"), release the claim, and exit **without** `record-review`.
A fresh review runs when the milestone re-completes.

## Outcome — the gate opens

Post the outcome on the tracker's **review artifact** (the adapter's binding).
The body is wire format; inside it (after the marker, and after the sparkle in
Mode B) sits the episode sentinel:

```text
<!-- agent-milestone-review:<milestone-id> -->
```

State the verdict against the milestone's goal, the per-member evidence you
judged it on, and that no follow-up was needed. Then, as your **final
action**: `dispatch graph record-review --id <milestone>`. If it refuses
because the milestone regained open work (a follow-up reached the graph since
you read it), that is the finished state: release the claim and exit — the
gate stays closed, and a fresh review runs when the milestone re-completes.

## Human input

When the verdict needs a human judgment you cannot make: ensure the review
artifact exists (post it stating what is pending, without recording a
verdict), solicit the question as a comment on it tagging ≥1 human, log `WAIT`
(name the artifact and the awaited answer), and poll the artifact's thread —
lazily (minutes, then tens of minutes; never faster than once per minute),
heartbeating the claim each poll. Keep ≤1 open question; never record the
outcome until an addressable response resolves it, then log `RESUME` and
finish the review. Both modes wait here — a review holds no compute slot, so
waiting is cheap.

## Log

`INFO` / `WAIT` / `RESUME` / `ERROR` one-liners in the
[`work-ticket` format](../work-ticket/reference.md#logging), with the
milestone's URL in `ticket=` (`-` where the tracker gives it none). A review
never transitions a ticket, so `TRANSITION` and state-change comments do not
apply.
