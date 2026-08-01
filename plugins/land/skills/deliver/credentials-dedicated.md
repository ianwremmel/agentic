# deliver — dedicated credentials

The agent has its own account (`credential_mode: dedicated`). Posts carry the
machine marker alone — **never add the sparkle wrapper**
([wire format](./reference.md#wire-format)).

## Operator notification

When an engagement edge fires (your operator-mode file says which), request
review from `operator_login` and post the engagement comment — marker +
`agent-engagement` sentinel
([mechanics](./reference.md#operator-engagement)).

## Gate 6 signals

Every form is available here. Any one satisfies the gate:

- `<review mode="human" role="operator" state="approved">` — the formal
  approval, and the one to expect;
- `<reaction emoji="+1">` from the operator on the engagement comment;
- a "go ahead" / "lgtm" / "ready" reply from the operator, on the engagement
  comment, the ticket, or out of band;
- a ticket-side approval, such as an operator status transition.

## Review rules

GitHub may refuse a Copilot review request from a bot account. Local context —
this repo's `CLAUDE.md`, `AGENTS.md`, or its docs — may name the way around it,
usually a second GitHub token in an environment variable to make the request
with. Look there first and use what it names.

With no such credential available, log `ERROR`, post a PR comment saying the
request was refused, and take your operator-mode file's *Copilot unavailable*
branch. A refused request is not a `BLOCK`.
