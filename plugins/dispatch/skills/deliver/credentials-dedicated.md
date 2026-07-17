# deliver — dedicated credentials

The agent acts under its own dedicated account (`credential_mode: dedicated`),
separate from the operator's. Posts appear under the agent's account and are
identified by the machine marker alone — **never add the sparkle wrapper**
([wire format](./reference.md#wire-format)).

## Operator notification

When an engagement edge fires (your operator-mode file says which), notify via
the platform's PR review-request API targeting `operator_login`. Also post the
engagement comment — marker + `agent-engagement` sentinel
([mechanics](./reference.md#operator-engagement)).

## Gate 6 signals

Every Gate 6 form is available, including the formal one: the operator's
approval typically lands as `<review mode="human" role="operator"
state="approved">` in the `pr-status` XML. Reaction, reply, and ticket-side
signals count too.

## Review rules

The agent MAY use alternative human credentials supplied for the purpose to
request a review type the platform restricts to human accounts (e.g. Copilot
review on GitHub).
