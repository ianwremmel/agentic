# PR Status Protocol

This document defines the wire format and cache layout that scripts
MUST follow when answering "what is the state of this PR?" for an
agent. It is a protocol specification, not an implementation guide:
it describes what scripts emit, where they cache thread content,
and how a calling skill consumes the result. It stays silent on
script names, language, and the specific API calls used to gather
the underlying data.

## Why this exists

When an agent polls a PR it repeatedly needs the same answers:

- have any checks failed?
- are there actionable comments?
- are there merge conflicts?
- has another agent reviewed it (typically Copilot)?
- has a human reviewed it?
- has anyone approved or requested changes?
- are there actionable inline annotations (CI lint warnings, etc.)?

Asking these through MCP every time is expensive and stochastic. A
script that emits a single deterministic XML document — and caches
the heavy text content (full comment threads, annotation bodies)
under a stable path — lets a skill answer all of the questions
above without burning context on raw API output.

This protocol is the read-side companion to
`agent-communication-protocol.md` and reuses that document's
actionability and mode-detection rules.

## Scope

The protocol covers:

- the XML document a status script emits to stdout
- the on-disk cache that script populates
- the rules a script uses to classify threads, reviews, and
  annotations

It does not cover:

- the names of the scripts that implement it (a single entry point
  is recommended for now; splitting it later does not change the
  wire format)
- the language or runtime the scripts are written in
- the specific platform APIs queried

## Cache layout

Per-PR cache root:

```
/tmp/<skill>/<repo-slug>/<pr-number>/
  threads/
    <thread-id>.md            # verbatim thread, oldest comment first
    <thread-id>.summary.md    # cheap-model summary, present iff non-actionable
  annotations/
    <annotation-id>.md        # verbatim annotation body
    <annotation-id>.summary.md
    <annotation-id>.ack       # empty marker; presence = non-actionable
```

- `<skill>` is the name of the invoking skill, so concurrent skills
  do not clobber each other's caches.
- `<repo-slug>` is `<owner>__<repo>` or the platform's analogous
  identifier with `/` replaced by `__`.
- `<thread-id>` and `<annotation-id>` are platform-stable
  identifiers (e.g. GitHub's `node_id`). They MUST be filename-
  safe; substitute or escape any path-unsafe characters.

The cache is persistent across sessions. Stale entries remain
until the PR merges or closes, at which point the writer SHOULD
remove `/tmp/<skill>/<repo-slug>/<pr-number>/` entirely. A new
commit on the PR head typically invalidates the platform's
annotation set; cached entries for annotations that no longer
appear in the API response are harmless because they stop
appearing in the XML output.

## Output: `<pr-status>`

The script emits a single XML document on stdout, UTF-8 encoded.

```xml
<pr-status repo="<owner>/<repo>" pr="42" head="<branch>">
  <checks state="passing|failing|pending">
    <check name="lint" conclusion="failure" url="..."/>
    <check name="test" conclusion="success" url="..."/>
  </checks>
  <merge-conflicts present="true|false"/>
  <reviews>
    <review author="<login>" mode="bot|human" state="commented|approved|changes_requested|dismissed"/>
  </reviews>
  <threads>
    <thread id="<thread-id>" actionable="true"  cache="<path>"/>
    <thread id="<thread-id>" actionable="false" cache="<path>">
      <summary>Cheap-model summary, 1-3 sentences.</summary>
    </thread>
  </threads>
  <annotations>
    <annotation id="<annotation-id>" actionable="true"  cache="<path>"/>
    <annotation id="<annotation-id>" actionable="false" cache="<path>">
      <summary>...</summary>
    </annotation>
  </annotations>
</pr-status>
```

### `<checks>`

`state` is the rollup: `failing` if any check failed, `pending` if
any check is in progress and none failed, `passing` otherwise.
Each `<check>` carries `name`, `conclusion`, and a `url` to the
provider's UI for that check.

### `<merge-conflicts>`

A single boolean. `present="true"` means the PR cannot merge
without conflict resolution.

### `<reviews>`

One `<review>` per submitted review (not per reviewer-requested).
`mode` is `bot` iff the platform classifies the account as a bot
OR the login matches the known agent-name patterns
(`*copilot*`, `*codex*`, `*claude*`, `*ai-agent*`, case-
insensitive); `human` otherwise. Default to `human` on
uncertainty. `state` is the platform's review state, normalized
to one of `commented`, `approved`, `changes_requested`,
`dismissed`.

### `<threads>` and `<annotations>`

Every thread and annotation present on the PR appears in the
output, regardless of actionability. The `cache` attribute is an
absolute path to the thread or annotation cache file. Skills read
that file directly when they need the full body; the XML itself
stays small.

`actionable="true"` elements omit `<summary>`. The skill is
expected to read the cache file and act.

`actionable="false"` elements MUST include `<summary>` with a
1-3-sentence cheap-model summary. The summary lets a skill skim
non-actionable conversations without loading the full thread.

## Actionability

### Threads

Follows agent-communication-protocol §"Thread-aware filtering"
verbatim. A thread is **non-actionable** iff:

- its newest comment was written by the calling agent AND carries
  a terminal signal (terminal reaction on GitHub, terminal token
  elsewhere), OR
- the platform has explicitly resolved it.

Otherwise the thread is **actionable**. In particular, a human
reply to an agent's previous turn flips the thread back to
actionable.

### Annotations

Annotations have no platform-level acknowledgement mechanism, so
the cache tracks it locally:

- An annotation is **actionable** by default.
- An annotation is **non-actionable** iff
  `annotations/<annotation-id>.ack` exists in the cache.

Writing the `.ack` marker is the agent's responsibility, not the
script's. Many annotations are informational; once an agent has
inspected one and decided no action is needed, it writes the
marker so future polls don't re-surface it. Annotations
frequently disappear from the platform on the next commit, in
which case they simply stop appearing in the XML output and the
stale cache entries get cleaned up when the PR closes.

## Summaries

Summaries for non-actionable threads and annotations are produced
by invoking `claude -p` with a cheap model. Each summary is 1-3
sentences and describes the conversation's outcome ("reviewer
asked X; agent answered Y; resolved").

Summaries are persisted alongside the thread / annotation cache
file as `<id>.summary.md`. Regeneration rules:

- If the cache file does not exist, write it and generate a
  summary.
- If the cache file exists and its content has not changed since
  the last run, reuse the existing summary.
- If the cache file content has changed, regenerate the summary
  and overwrite `<id>.summary.md`.

The script SHOULD detect "content has not changed" cheaply (e.g.
a content hash stored next to the cache, or a byte-for-byte
comparison of the serialized thread). The exact mechanism is
implementation-defined.

## Mode classification

The `mode="bot|human"` attribute on `<review>`, and on any future
author-bearing element, follows the same predicate as
agent-communication-protocol Mode A:

- `bot` iff the platform types the account as a bot, OR the
  identifier matches the known agent-name patterns above.
- `human` otherwise.

Default to `human` on uncertainty.

## Calling agent identity

Thread actionability depends on whether "the calling agent" wrote
the newest comment. The script therefore needs to know which
agent it is running on behalf of so it can read the
`<!-- agent-reply:<agent-id> -->` machine marker
(or the platform's equivalent) and tell its own writes apart from
those of other agents on the same thread. The mechanism for
passing that identity into the script — environment variable, CLI
flag, config file — is implementation-defined.
