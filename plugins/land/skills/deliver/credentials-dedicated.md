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

Every Gate 6 form is available, including the formal
`<review mode="human" role="operator" state="approved">`.

## Review rules

GitHub may refuse a Copilot review request from a bot account. On refusal, log
`ERROR`, post a PR comment saying so, and take your operator-mode file's
*Copilot unavailable* branch. A refused request is not a `BLOCK`.
