# land — dedicated credentials

The agent has its own account, so its posts are already distinguishable by
author. The wire format is the one in
[`reference.md`](./reference.md#wire-format), unchanged.

## Operator notification

When an engagement edge fires (your operator-mode file says which), request
review from `operator_login` and post the engagement comment — marker +
`agent-engagement` sentinel
([mechanics](./reference.md#operator-engagement)).

## Gate 6 signals

All four forms exist here; any one satisfies the gate:

- `<review mode="human" role="operator" state="approved">` — the formal
  approval, and the one to expect;
- `<reaction emoji="+1">` from the operator on the engagement comment;
- a "go ahead" / "lgtm" / "ready" reply from the operator, on the engagement
  comment, the ticket, or out of band;
- a ticket-side approval, such as an operator status transition.

## Review rules

GitHub may refuse a Copilot review request from a bot account. Local
instructions may provide a way around it — commonly a second GitHub token to
request with. Use it if one is available.

Otherwise, or if the request is refused anyway, log `ERROR`, post a PR comment
saying it was refused, and take your operator-mode file's *Copilot unavailable*
branch. A refused Copilot request is not a `BLOCK`.
