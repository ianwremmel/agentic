# Agent Communication Protocol

This document defines the on-the-wire protocol that any agent MUST
follow when it speaks to humans in a PR, issue, or ticket comment
stream. It is a protocol specification, not an implementation guide:
it describes what writers emit and what readers accept, and stays
silent on bash helpers, API endpoints, storage formats, and similar
concerns.

## Why this exists

Agents talk to humans in three venues:

1. **PR issue comments** — the top-level comment stream on a pull
   request.
2. **PR inline review comments** — threads anchored to a file and
   line.
3. **Ticket comments** — comments on an issue in any tracker
   (GitHub Issues, Linear, Jira, Asana, or anything else). Where a
   tracker supports threaded comments, each thread follows the same
   rules as a PR inline review thread.

The in-product chat inside the Claude Code client (web, desktop,
iOS/macOS) is a separate surface: the protocol governs what the
agent writes into the three venues above, not what appears in the
chat. The chat MAY mirror what the agent posts into a venue, but
MUST NOT be used as a substitute for it. See "Claude Code on the
web" below.

Two facts make the problem awkward:

- The same comment stream is read by humans (who want to know who
  wrote what) and by other agents (which need to skip their own
  writes when polling for new work, to avoid feedback loops).
- An agent may be authenticated as a dedicated bot identity, or it
  may be authenticated as a human — usually the human who kicked
  off the session. In the second case the account byline gives the
  reader no hint that the agent, not the human, produced the text.

The protocol fixes both by requiring every agent-authored post to
carry a **machine-readable marker** (always) and, when the account
doesn't already signal "this is an agent," a **visible marker**
(sparkles) so a human reader can tell at a glance.

## Environments

These are the runtime environments the protocol expects to handle.
The mode column is determined purely by the credentials the client
gives the agent — nothing about the environment itself changes the
rules.

| # | Environment                 | Auth                          | Mode                   |
| - | --------------------------- | ----------------------------- | ---------------------- |
| 1 | Claude Code CLI on laptop   | user's platform credentials   | B (human-credentialed) |
| 2 | Claude Code on the web      | user's platform credentials   | B (human-credentialed) |
| 3 | Claude Code in a sandbox    | dedicated `ai-agent` identity | A (agent-credentialed) |
| 4 | Claude Code iOS / macOS app | user's platform credentials   | B (human-credentialed) |

Scenarios 1, 2, and 4 post through the user's account with the
sparkle wrap so the human can distinguish their own comments from
their agent's. Scenario 3 posts through a dedicated bot account and
needs only the machine marker.

### Claude Code on the web

Today Claude Code on the web tends to reply to a PR or ticket event
by writing to the in-product chat only. **That is not compliant with
this protocol.** When the web client is subscribed to a PR or ticket
and answers a comment event, the reply MUST be posted into the
originating venue (PR issue comment, PR inline thread, or ticket
comment). The in-product chat MAY additionally mirror the reply,
but it cannot be the sole destination — anyone not looking at Claude
Code at that moment would never see the response.

## Modes

Every agent post is produced in exactly one of two modes. The mode
is determined at write time from the credentials the agent currently
holds; it is NOT a config switch.

### Mode A — Agent-credentialed

The credentials identify a bot / service / app — not a human
teammate. Two signals decide this:

- **Platform-typed identities.** Some platforms explicitly classify
  an account as a bot / integration / service account (e.g.
  GitHub's `type: "Bot"`). An identity so classified is always
  Mode A.
- **Name matching.** Where the platform doesn't classify identities
  (or to catch bot-like accounts the platform nominally types as
  users), the identifier is matched against known agent-name
  patterns — e.g. `*copilot*`, `*codex*`, `*claude*`, `*ai-agent*`
  — case-insensitive, against whichever identifier the platform
  surfaces (login, display name, email local-part). Name matching
  applies on every platform, not just GitHub.

In this mode the byline itself tells readers the author is an
agent, so no visible wrapper is added. Only the machine marker is
written.

### Mode B — Human-credentialed

The credentials identify a human teammate. The byline would look
exactly like a human comment, so the protocol requires a **visible
sparkle block** around the body in addition to the machine marker.

### Detection

The mode is determined at write time by inspecting the credentials.
Every writer implements a predicate "is this human-credentialed?"
that answers Yes / No for its platform.

**Default to Mode B on uncertainty.** If the identity lookup fails
or the result is ambiguous, write in Mode B. Adding sparkles to a
post from a bot account is harmless — the byline already tells the
reader what's happening. Omitting sparkles on a post that looks
human-authored is much worse: the reader has no way to tell the
agent spoke.

## Wire format

### Machine marker

Every agent-authored post MUST carry a machine-readable marker that
the platform preserves verbatim in what readers see via the API.
The marker has two purposes:

1. Let readers (humans or other agents) tell "this was written by
   an agent" without looking at the byline.
2. Let readers identify *which* agent wrote it, so multiple agents
   can coexist on the same thread without stepping on each other.

The marker carries an agent identifier (opaque to readers; chosen
by the agent). Where the platform supports HTML comments, the
recommended form is:

```
<!-- agent-reply:<agent-id> -->
```

Where the platform strips HTML comments or only accepts structured
content (ADF, rich-text, etc.), the marker MUST still carry the
same information, using whatever mechanism the platform preserves:
a custom field / property on the comment object, a trailing
sentinel line, or a hidden structured-content node. The specific
form is platform-dependent; the requirement is that readers on the
same platform can reliably detect and read it.

A single bare `<!-- agent-reply -->` (no agent-id) is accepted for
legacy compatibility and means "some agent wrote this, identity
unknown."

### Visible marker (Mode B)

In Mode B the body MUST be wrapped in a visible sparkle block:

```
{machine marker}
✨

{body}

✨
```

- Leading and trailing lines are `✨` (U+2728) on their own.
- One blank line of padding on each side of the body.
- The sparkle wrap MUST NOT appear in Mode A.
- The body itself is unchanged Markdown. Writers MUST NOT embed
  the marker or sparkle sentinels inside the body.

The sparkle wrap renders correctly on every tracker we've seen so
far, so Mode B uses the same visual format regardless of platform.

## Read side

Every comment in the stream MAY be relevant to the agent — there is
no blanket "skip all bot comments" or "skip everything with an
agent marker" rule. On each poll / event, the agent evaluates each
comment and decides whether to participate.

To avoid re-evaluating a comment the agent has already decided
about, the agent MUST mark it as processed. How:

- **On platforms with reactions** (GitHub): apply one of the
  terminal reactions described below.
- **On platforms without reactions**: leave a reply whose body
  ends with one of the terminal tokens described below, or record
  the comment id in a platform-appropriate state store.

### Thread-aware filtering

In a threaded venue (PR inline review comments, most trackers), a
thread may look like: human → agent reply → human reply → agent
reply. Earlier agent turns are part of the conversation and MUST
NOT be stripped from what the agent reads — dropping them loses
context. Only the *trailing* agent turn on a thread whose newest
comment carries the agent's own marker may be skipped, because
that turn represents the agent's already-emitted answer.

Restated: skip a thread only when the newest comment was written
by this agent AND carries a terminal signal. If a human has
replied to the agent's reply, the thread is re-opened and the
whole conversation is in play again.

## Terminal signals

A terminal signal says "the agent is done with this comment." A
non-terminal signal says "the agent has seen it and is still
working."

### Reactions

On GitHub the agent signals status with reactions. Any reaction
the platform supports is fair game. Three carry terminal semantics
and one carries non-terminal semantics; the rest are neutral and
do not affect re-evaluation.

| Reaction   | Semantics                                         |
| ---------- | ------------------------------------------------- |
| `+1`       | Terminal. Addressed / agreed.                     |
| `-1`       | Terminal. Rejected (with an explaining reply).    |
| `rocket`   | Terminal. Shipped / merged / applied.             |
| `eyes`     | Non-terminal. Seen; work in progress.             |

Any other reaction (`heart`, `hooray`, `laugh`, `confused`, …) is
allowed but carries no protocol meaning. Only terminal reactions
suppress re-evaluation on the next poll.

### Text tokens

On platforms without a reactions mechanism, the equivalent
terminal signal is a short closing token on its own line at the
end of the reply body:

| Terminal token | Semantics                              |
| -------------- | -------------------------------------- |
| `Done.`        | Addressed / agreed (≈ `+1`).           |
| `Declined.`    | Rejected — explanation immediately above (≈ `-1`). |
| `Shipped.`     | Shipped / merged / applied (≈ `rocket`). |

The token MUST be the last non-empty line of the body so readers
can detect it with a suffix match. Non-terminal acknowledgement
has no text equivalent — the absence of a closing token means
"still working."

On a platform that has neither reactions nor reliably preserved
markers, the agent SHOULD fall back to a private state store
(keyed by comment id) rather than degrading the in-stream
protocol.

## Writing

There are three kinds of writes an agent produces:

- **New top-level comment** on a PR / issue / ticket.
- **Reply in an existing thread** (PR inline thread or
  tracker-side comment thread).
- **Reaction** (on platforms that support it).

Every body-bearing write (top-level or reply) MUST emit the
machine marker, and MUST emit the sparkle wrap if the writer is in
Mode B. Reactions carry no body and therefore no marker.

The specific API calls / SDK methods are out of scope for this
document.

## Review requests

On some platforms, requesting certain kinds of reviews is
restricted to human accounts. The canonical example is GitHub,
where Copilot reviews can only be requested by human users, not by
bot accounts. When an agent needs to request such a review from
Mode A, it may need to obtain alternative credentials (a token
belonging to a human user, granted for this purpose) to make the
call. The specifics are a platform- and deployment-level concern
and out of scope for this protocol.

An agent MUST NOT request a review from the same user account it
is authenticated as — that's a self-review and platforms generally
reject it.

## Open questions

- **Web-client wiring.** Claude Code on the web currently tends to
  reply in the in-product chat when it receives a PR/ticket event.
  The protocol requires those replies to land in the originating
  venue instead; wiring that through is tracked separately.
- **Per-platform marker catalog.** For each platform we integrate
  with, we need to record the specific marker mechanism used
  (HTML comment, custom field, sentinel line, …) so every agent
  running against that platform can read and write it compatibly.
  This catalog lives alongside the platform integrations, not in
  this document.
