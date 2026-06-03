# deliver — protocol reference

Condensed from the dispatch spec (§2.1 Communication, §2.2 PR Status, §2.3
Operational Logging). Only the parts `deliver` relies on are reproduced here so
the skill is self-contained once installed. The full spec is authoritative where
they differ.

`scripts/pr-status` is this skill's bundled implementation of the status reader
the spec describes as `dispatch pr-status` (the not-yet-built CLI, #66); the two
names denote the same reader. Everything below applies to it under either name.

## Roles (§1)

- **Agent** — the agentic coding assistant doing the work (this skill).
- **Operator** — the individual directing the agent. Exactly one per
  agent session; almost certainly a human; the only human with stop
  authority over the agent. May share platform credentials with the
  agent (Mode B).
- **Reviewer** — any participant — Copilot, another agent, or a human —
  leaving review feedback on a PR. The operator may also be a reviewer
  of the agent's PRs.

## Mode detection (§2.1)

Determined by the credentials held at write time, not the environment.

- **Mode A** (agent-credentialed) iff EITHER the platform types the account as a
  bot/integration/service account, OR the identifier (login, display name, or
  email local-part) matches `*copilot*`, `*codex*`, `*claude*`, or `*ai-agent*`
  case-insensitively.
- **Mode B** (human-credentialed) otherwise. **On any ambiguity, default to Mode
  B.**

## Wire format (§2.1)

Every agent-authored post (new top-level post or thread reply — not reactions)
carries exactly one machine marker as its **first line**, alone, no leading
whitespace:

```
<!-- agent-reply:<agent-id> -->
```

In **Mode B**, the body is additionally wrapped in a sparkle block after the
marker:

```
<!-- agent-reply:dispatch -->
✨

{body}

✨
```

The sparkle (U+2728) sits alone on its own line, one blank line in from the body
on each side. The wrapper MUST NOT appear in Mode A posts.

The plan-comment sentinel `<!-- agent-plan:<agent-id> -->` goes **inside** the
body (after the marker in Mode A, after the opening sparkle in Mode B), never as
the leading line.

## Terminal signals (§2.1)

A terminal signal means "finished with this item"; it suppresses re-evaluation
on the next poll. Anything else means "still working."

The agent signals "finished" **only** through a terminal signal — it MUST NOT
resolve the thread, including one it opened itself. Resolution is a human's
call; a thread being non-actionable to the agent does not mean a human
participant is satisfied. Platform-resolved threads are read (see
§Actionability) but never written by the agent.

Reactions (preferred where supported):

| Reaction | Meaning                               |
| -------- | ------------------------------------- |
| `+1`     | Terminal — addressed / agreed         |
| `-1`     | Terminal — rejected (with a reply)    |
| `rocket` | Terminal — shipped / merged / applied |
| `eyes`   | Non-terminal — seen, work in progress |

Text tokens (platforms without reactions) — must be the **last non-empty line**:

| Token       | Meaning               |
| ----------- | --------------------- |
| `Done.`     | Terminal (≡ `+1`)     |
| `Declined.` | Terminal (≡ `-1`)     |
| `Shipped.`  | Terminal (≡ `rocket`) |

## Review rules (§2.1)

- An agent MUST NOT request review from the account it is authenticated as.
- A Mode A agent MAY use alternative human credentials to request a review type
  the platform restricts to humans (e.g. Copilot review on GitHub).
- **Mode B inverse:** on a PR the agent authored under shared credentials, the
  absence of a formal `changes_requested` review does NOT mean "no changes
  requested." Every comment the operator leaves is either a question to answer
  or an implicit change request.
- **Sole-reviewer case.** "MUST NOT request review from self" constrains the
  *request side-effect*, not the loop. When the calling agent is the PR author
  and no eligible non-self human reviewer exists, the agent skips the request
  but does not exit — it keeps polling on the reviewer cadence until the PR
  closes, and the universal `merged → done` terminal handles the eventual
  closure. Terminating early because there's nobody to ask is non-conforming.

### Operator engagement (deliver-specific)

The `deliver` skill engages the operator on two edges: `ready_for_private_review
→ private_review_requested` (team mode) and `ready_for_public_review →
public_review_requested` (solo mode). Each engagement is two parts: a
**notification** (the Mode-specific venue below) plus an **engagement
comment** — a top-level PR comment the agent posts carrying the
`<!-- agent-reply:<agent-id> -->` machine marker AND, inside the wrapped body
(like the plan comment's sentinel), an engagement sentinel
`<!-- agent-engagement:<agent-id> -->`. The engagement comment is the anchor
for reaction- and reply-based Gate 6 signals (a `+1` reaction or "go ahead"
reply on it counts); the agent posts it regardless of Mode, since the
notification venues below are not PR comments the operator can react to.

The engagement sentinel makes the comment classify **non-actionable** (see
§Actionability below) — exactly like the plan comment. Without it the agent's
own soliciting comment would stay actionable forever (no terminal signal),
permanently failing Gate 4 and blocking draft-clear/merge. Do **not**
terminal-tag the engagement comment instead: the agent is awaiting approval,
not finished with the item.

Notification venue by Mode:

- **Mode A** (separate bot account). Use the platform's PR review-request API,
  targeting `operator_login` if set, otherwise the ticket assigner (same
  selection mechanism §2.4.2 uses for human reviewers).
- **Mode B** (shared credentials). The PR review-request API cannot target the
  authenticated account, so use the same venues §2.4.2 specifies for Mode B
  human-review engagement: a ticket comment tagging the operator first, then an
  implementation-defined out-of-band channel. Operator identity is the
  authenticated account itself.

### Audience by visibility stage

The lifecycle names states by **PR visibility**, not audience. Audience falls
out of the mode:

| State family       | Visibility           | Audience (solo mode) | Audience (team mode)            |
| ------------------ | -------------------- | -------------------- | ------------------------------- |
| `private_review_*` | draft (not cleared)  | unreachable          | operator                        |
| `public_review_*`  | draft cleared        | operator             | non-operator team reviewer(s)   |

In team mode the operator is **excluded** from the public reviewer set; the
operator's binding signal is collected during `private_review_*` via Gate 6.

## Actionability (§2.2)

**Why agents must not read PR state directly (§2.2.1).** A raw platform read —
`gh pr view --json`, `gh pr checks`, `gh api …/comments|/reviews`, or an MCP PR
read — returns thousands of tokens of mostly irrelevant fields, and that cost
recurs on every poll until the context window fills. Worse, as a session grows,
agents drift toward ad-hoc API calls and skip the established command, producing
inconsistent snapshots that bypass the actionability classification (plan/own-reply
suppression, thread resolution, `.ack`) and the disk cache the gates rely on.
`scripts/pr-status` exists to fix exactly this: one coherent snapshot, heavy
content written to stable disk paths, and a compact XML summary that answers every
polling question at once. Drive **all** gate and actionability decisions from it,
reading the cache files it wrote rather than re-fetching. This isn't a blanket
ban on platform reads — investigating something emergent the snapshot and cache
don't cover may legitimately need a direct read — but the PR status you act on
comes only from `pr-status`, and routine direct `gh`/MCP calls are writes.

The `pr-status` script applies these rules; the agent reads the resulting
`actionable="true|false"` and treats it as the **sole task source** — no gate or
lifecycle decision is re-derived from anything else. A non-actionable item also
carries a `reason=` token naming *why* it was suppressed (`resolved`,
`agent-artifact`, `agent-terminal-reply`, `acked`). A `<summary>` is a **reading
aid, not a work queue**: a recap of the item so far, so that when the item is
`actionable="true"` the agent reads the summary plus the new content from the
`cache` file instead of re-reading the whole thread, and when it is
`actionable="false"` the summary is just context. The summary describes the
item's *content*, not its resolution, so an item the agent already terminal-tagged
will summarize as if the reviewer's point still stands — that is expected and is
**not** grounds to reopen it or to enumerate summaries as a to-do list. Trust the
flag (and the `reason=`); never let summary prose re-actionable a suppressed item.

Reviews are surfaced as one persistent record per reviewer under `<reviews>`,
each with a `state` of `pending | commented | changes_requested | approved`
(plus `dismissed`). `state="pending"` is a requested-but-undelivered review: it
is in-flight, not absent — an empty thread set while a review is `pending` is not
convergence (a bot reviewer's inline threads can land minutes later). An
outstanding request **overrides** any prior verdict back to `pending` until the
reviewer re-reviews ("remain until replaced"). A review still being *drafted*
(unsubmitted) is not surfaced at all until it is submitted. Keep polling rather
than chasing either through raw reads.

For reference, a comment or thread is **non-actionable** iff any of:

- the body is one of the calling agent's artifact comments — a line-anchored
  `<!-- agent-plan:... -->` (plan comment) or `<!-- agent-engagement:... -->`
  (operator engagement comment) sentinel AND a comment author matching the
  calling gh identity. These are the agent's own working/soliciting comments;
  they never need to be "addressed." The engagement comment in particular
  anchors operator approval (Gate 6) and must stay non-actionable while the
  agent awaits a reaction/reply, else Gate 4 would block draft-clear/merge.
  (The author match keeps a *human* comment that merely quotes a marker
  actionable.)
- the newest comment was written by the calling agent (gh-reported author
  equals the calling identity) AND carries an `<!-- agent-reply:... -->` marker
  AND its last non-empty line is a terminal signal (`Done.` / `Declined.` /
  `Shipped.`, case-insensitive, trailing period optional, or `✓`/`✅`). Author
  identity is load-bearing here: a human quoting the marker plus a terminal
  word in their own comment stays actionable. If `gh api user` fails so the
  caller identity isn't known, the check degrades to the pre-fix "exact
  `$DISPATCH_AGENT_ID` marker alone" rule so actionability still falls; a
  warning is written to stderr.
- the platform has explicitly resolved the thread (threads only).

A reviewer reply after the agent's last turn makes the item actionable again.
An annotation is actionable unless `<cache>/<id>.ack` exists.

## Operational logging (§2.3)

One line per entry:

```
<timestamp> <kind> ticket=<ticket-url> pr=<pr-url> ticket-role=<role> pr-state=<state> | <message>
```

- `<timestamp>`: RFC 3339 with offset, second precision.
- `<kind>`: `TRANSITION` | `WAIT` | `RESUME` | `BLOCK` | `INFO` | `ERROR`.
- `ticket=` / `pr=`: full URLs, never bare IDs; `-` when absent.
- `<pr-state>`: the resolved `<terminal state>` from `pr-status` — `draft` |
  `open` (non-terminal) or `shipped` | `abandoned` (terminal); `-` when no PR.
  `shipped` covers every way a change lands in base (GitHub-merge, merge-queue
  fast-forward, squash/rebase by external tooling); `abandoned` is closed with
  the change absent from base.

Kinds `deliver` emits:

| Kind         | When                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| `INFO`       | Heartbeats while monitoring/polling; substantive non-state events.                      |
| `WAIT`       | Entering a poll for an external condition; message names the venue and awaited outcome. |
| `RESUME`     | The awaited condition is met and active work resumes.                                   |
| `ERROR`      | Errors surfaced but not immediately fatal.                                              |
| `TRANSITION` | (Ticket-driven runs only) a ticket role change.                                         |

When a linked ticket's role changes, also post a state-change comment to the PR
(or ticket) following the §2.1 wire format, body exactly:

```
State: <prev-role> → <new-role>
Rationale: <one line; required for corrective and cancel transitions>
```
