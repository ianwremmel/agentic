# Agent Communication Protocol

Status: draft
Scope: every plugin in this marketplace whose agents post on GitHub or Linear.
Today that's `pull-requests` (PR issue comments, PR inline review comments,
reactions) and `linear` (ticket comments). This doc defines the wire format
those posts MUST follow so that humans and agents can both read the stream
without confusion.

## Why this exists

Agents talk to humans in three venues:

1. **PR issue comments** — the top-level comment stream on a GitHub PR.
2. **PR inline review comments** — threads anchored to a file and line.
3. **Ticket comments** — Linear issue comments (and, later, any other tracker
   a plugin integrates with).

Two facts make this awkward:

- The same comment stream is read by humans (who want to know who wrote
  what) and by other agents (which need to skip their own writes when
  polling for new work, to avoid feedback loops).
- An agent may be authenticated as a dedicated bot identity, or it may be
  authenticated as a human — usually the human who kicked off the session.
  In the second case the account byline gives the reader no hint that the
  agent, not the human, produced the text.

The protocol fixes both by requiring every agent-authored post to carry
a **machine-readable marker** (always) and, when the account doesn't
already signal "this is an agent," a **visible marker** (sparkles) so a
human reader can tell at a glance.

## Modes

Every agent post is produced in exactly one of two modes. The mode is
determined at write time from the credentials the agent currently holds;
it is NOT a config switch.

### Mode A — Agent-credentialed

The agent holds credentials for an identity that is obviously not a
human teammate. On GitHub that means either:

- `GET /user` returns `type == "Bot"`, or
- `type == "User"` but the login matches `*copilot*`, `*codex*`,
  `*claude*`, or `*ai-agent*` (case-insensitive).

On Linear the equivalent is an OAuth app / API key that belongs to a
bot user, not to a seat held by a human teammate.

In this mode the byline itself tells readers the author is an agent, so
no visible wrapper is added. Only the machine-readable marker is
needed.

### Mode B — Human-credentialed

The agent is using credentials that GitHub / Linear will display as a
human teammate. `GET /user` returns `type == "User"` and the login does
not match any of the agent-name patterns above.

In this mode the byline looks exactly like a human comment. The
protocol requires a **visible sparkle block** around the body so a
reader skimming the thread can tell the agent authored it.

### Detection (GitHub)

```bash
is_human_auth() {
  # "User" + login not matching any known agent-name pattern
  # See plugins/pull-requests/scripts/lib/gh-auth.bash
}
```

Detection must be best-effort safe: if the identity call fails (rate
limit, network, unauthenticated), treat the mode as Mode A (no sparkle
wrap). Rationale: losing the visible marker is a readability bug;
adding sparkles to a legitimate human author would corrupt their
comment.

### Detection (Linear)

Linear's `viewer` query returns an `isMe` and a user record with
`email`, `displayName`, and a boolean `admin`. Linear does not
distinguish "bot user" vs "human user" at the API level; use the same
convention as GitHub — an agent-looking `name` / `displayName` /
`email` local-part (`*copilot*`, `*codex*`, `*claude*`, `*ai-agent*`)
is Mode A; anything else is Mode B.

## Wire format

Every agent post MUST be produced by a single helper (`wrap_agent_body`
or its Linear equivalent) so the format stays consistent across
plugins.

### Mode A (agent-credentialed)

```
<!-- agent-reply -->
{body}
```

### Mode B (human-credentialed)

```
<!-- agent-reply -->
✨

{body}

✨
```

- The HTML comment `<!-- agent-reply -->` is the machine marker. It
  MUST be on its own line at the start of the body. It MUST be
  present in both modes.
- The `✨` (U+2728) lines bracket the body with one blank line of
  padding on each side. This is the visible marker. It MUST be
  present in Mode B and MUST NOT be present in Mode A.
- The body itself is unchanged Markdown. Agents must not embed the
  marker or sparkle sentinels inside the body.

### Ticket comments (Linear)

Linear renders Markdown but strips raw HTML in most surfaces. The
`<!-- agent-reply -->` comment is preserved in the source markdown
(which is what the API returns), so the machine marker still works for
polling. The sparkle wrap renders the same in both venues.

If a future tracker strips HTML comments from the stored body, that
plugin must define an alternative machine marker (for example, a
trailing zero-width-joiner sequence, or a dedicated body field) and
document it alongside this protocol.

## Read side

Any poll / watch loop that reads a comment stream MUST:

1. Filter out posts whose body contains `<!-- agent-reply -->`.
   These are the agent's own writes; surfacing them would feed the
   agent its own output.
2. Keep posts from Copilot (`user.login == "copilot"`) even though
   Copilot is a bot — it acts as a reviewer whose comments the agent
   needs to read.
3. Otherwise filter out `user.type == "Bot"` authors to ignore
   routine automation (CI bots, Dependabot status, etc.) unless a
   plugin opts in to a specific bot.

## Reactions as terminal signals

GitHub reactions are the protocol for "the agent has finished with
this comment." They MUST be used only to close the loop, not to
editorialize.

| Reaction | Meaning |
| --- | --- |
| `+1` | Addressed / agreed / done. |
| `-1` | Rejected — with an accompanying inline or issue reply that explains why. |
| `rocket` | Shipped / merged / applied. |
| `eyes` | Non-terminal acknowledgement — agent has seen the comment and is working on it. |

`+1`, `-1`, and `rocket` are **terminal**: the poll loop skips any
comment that carries one of these reactions from the agent's own
login. `eyes` is explicitly non-terminal and does not suppress the
comment on the next poll.

Agents MUST NOT use `heart`, `hooray`, `laugh`, or `confused` as
protocol signals. Those reactions are reserved for humans.

On Linear (and other trackers) that do not support reactions, the
equivalent terminal signal is a reply in Mode A/B with a recognizable
short form (e.g. `Done.`, `Applied.`). Plugins MUST document the
specific tokens they emit so a human reader can still skim them.

## Write side

Every agent write goes through one of these endpoints:

| Venue | GitHub API | Plugin entry point |
| --- | --- | --- |
| PR issue comment | `POST /repos/:o/:r/issues/:n/comments` (via `gh pr comment`) | `orchestrate reply --issue <pr> <body>` |
| PR inline reply | `POST /repos/:o/:r/pulls/:n/comments/:id/replies` | `orchestrate reply --inline <pr> <comment_id> <body>` |
| Reaction | `POST /repos/:o/:r/{pulls\|issues}/comments/:id/reactions` | `orchestrate react <id> <reaction> --type inline\|issue` |
| Linear comment | `commentCreate` mutation | (linear plugin equivalent; TBD) |

All write paths MUST run the body through `wrap_agent_body` (or the
plugin's Linear equivalent) before posting. Callers MUST NOT bypass
the wrapper — not even for "just a one-liner" — so that the marker
and mode are never forgotten.

## Review requests and token rotation

Requesting a review is a write action that looks like a comment event
to the recipient but does not itself carry a body. The mode rules
don't apply (there's nothing to wrap), but auth still matters:

- **Copilot review**: allowed from a human account; usually rejected
  from a bot account. The `review copilot` subcommand detects Mode A
  and rotates in `GH_REVIEW_REQUEST_TOKEN` for the duration of the
  call. The rotation happens inside a subshell so `GH_TOKEN` never
  leaks into the caller.
- **Human review**: skipped when the agent is authenticated as that
  same human — GitHub rejects self-reviews, and it's a confusing
  thing to ask for.

## Plugin checklist

A new plugin that posts to humans must:

- [ ] Use `wrap_agent_body` (or a documented Linear equivalent) for
      every write.
- [ ] Implement `is_human_auth` (or a documented Linear equivalent)
      and treat detection failure as Mode A.
- [ ] Filter `<!-- agent-reply -->` in every poll loop.
- [ ] Use only the four documented reactions, with `+1` / `-1` /
      `rocket` as terminal and `eyes` as non-terminal.
- [ ] Document any venue-specific deviations (e.g. a tracker that
      strips HTML comments) in this file or in a sibling doc it
      links to.

## Open questions

- Linear comment marker: confirm that the `<!-- agent-reply -->`
  comment survives round-tripping through the Linear API in both the
  rich-text and markdown surfaces. If not, define an alternative
  machine marker for Linear specifically.
- Cross-venue watermarking: the `pull-requests` plugin stores comment
  watermarks in a `clc-progress` YAML block embedded in the PR body.
  Linear has no equivalent "long-lived body"; a separate state file
  or a dedicated Linear custom field will be needed.
- Multi-agent disambiguation: the marker tells readers "an agent
  wrote this" but doesn't tell them which agent. If we ever run two
  agents against the same PR/ticket concurrently we'll want to extend
  the marker to `<!-- agent-reply:<agent-id> -->` and update the
  poll-side filter accordingly.
