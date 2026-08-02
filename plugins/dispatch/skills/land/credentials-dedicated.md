# land — dedicated credentials

The agent has its own account (`credential_mode: dedicated`), so its posts are
already distinguishable by author.

## Wire format

The machine marker ([wire format](./reference.md#wire-format)) and then the body,
plain. Add no wrapper, banner, or decoration around it.

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

GitHub may refuse a Copilot review request from a bot account. **Before**
requesting, check this repo's `CLAUDE.md`, `AGENTS.md`, and docs for a
workaround token — usually a second GitHub token in an environment variable —
and request with what they name.

If none is named, or the request is refused anyway, log `ERROR`, post a PR
comment saying it was refused, and take your operator-mode file's *Copilot
unavailable* branch. A refused Copilot request is not a `BLOCK`.
