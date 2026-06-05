# §2.2.2 — PR Status Protocol: Normative

## Scope

The protocol covers:

- the XML document `dispatch pr-status` emits to stdout
- the on-disk cache it populates
- the rules it uses to classify comments, threads, reviews, and annotations

It does not cover the specific platform APIs queried to gather the underlying
data.

## Caller obligations

A caller acting on PR state MUST derive its gate evaluation and actionability
decisions solely from a `dispatch pr-status` snapshot and the on-disk cache that
command populates. It MUST NOT call `gh pr view`, `gh pr checks`,
`gh api …/comments`, `gh api …/reviews`, or any MCP PR read to evaluate gates or
otherwise read the PR *status* it acts on. When it needs the full content of a
comment, thread, or annotation, it reads the cached file `dispatch pr-status`
already wrote rather than re-fetching.

This is not a blanket ban on platform reads. If a caller must investigate
something emergent that the snapshot and cache do not cover — data not available
locally — it MAY fetch that data directly. The obligation is narrower but firm:
the PR status a caller routes its lifecycle decisions through comes only from
`dispatch pr-status`. A caller's routine direct platform calls are **writes**
(e.g. posting a reply, requesting a review, marking a PR ready, adding a
reaction). Note that resolving a thread is not among an agent's writes — see
§2.1.2 §Writing rules.

This obligation exists because ad-hoc status reads burn context on every poll
and bypass the actionability classification, summaries, and on-disk cache that
`dispatch pr-status` owns (§2.2.1).

## Cache layout

The per-PR cache root is:

```
<base>/<skill>/<repo-slug>/<pr-number>/
  comments/
    <comment-id>.md
    <comment-id>.summary.md
  threads/
    <thread-id>.md
    <thread-id>.summary.md
  annotations/
    <annotation-id>.md
    <annotation-id>.summary.md
    <annotation-id>.ack
```

- `<base>` is an implementation-defined writable directory (e.g. `/tmp` or a
  persistent state directory). It MUST be consistent across runs for the same
  skill.
- `<skill>` is the name of the invoking skill. Concurrent skills MUST use
  distinct skill names so their caches do not collide.
- `<repo-slug>` is `<owner>__<repo>`, with `/` replaced by `__` and any other
  path-unsafe characters escaped or substituted.
- `<pr-number>` is the decimal PR number.
- `<comment-id>`, `<thread-id>`, and `<annotation-id>` are platform-stable
  identifiers (e.g. GitHub's `node_id`). They MUST be filename-safe; substitute
  or escape any path-unsafe characters.

### Cache files

| Path                              | Contents                                                              |
| --------------------------------- | --------------------------------------------------------------------- |
| `comments/<id>.md`                | Verbatim top-level comment content                                    |
| `comments/<id>.summary.md`        | 1–3-sentence model summary; present iff comment is non-actionable    |
| `threads/<id>.md`                 | Verbatim thread content, oldest comment first                         |
| `threads/<id>.summary.md`         | 1–3-sentence model summary; present iff thread is non-actionable     |
| `annotations/<id>.md`             | Verbatim annotation body                                              |
| `annotations/<id>.summary.md`     | 1–3-sentence model summary; present iff annotation non-actionable    |
| `annotations/<id>.ack`            | Empty marker file; presence means annotation is non-actionable        |

### Cache lifecycle

The cache persists across sessions. The script MUST update cached entries
incrementally — fetching only what has changed — rather than re-fetching
everything on every run.

When a PR merges or closes, the writer SHOULD remove the entire
`<base>/<skill>/<repo-slug>/<pr-number>/` directory.

A new commit on the PR head typically invalidates the platform's annotation set.
Cached `.md` and `.summary.md` files for annotations that no longer appear in
the API response are harmless: they simply stop appearing in the XML output and
are cleaned up at PR close.

## XML output

The script MUST emit a single well-formed UTF-8 XML document on stdout:

```xml
<pr-status repo="<owner>/<repo>" pr="42" head="<branch>">
  <terminal state="open|draft|shipped|abandoned" gh-merged="true|false" ahead-by="0|<n>|-"/>
  <checks state="passing|failing|pending">
    <check name="lint" conclusion="failure" url="..." informational="false" stuck="false"/>
    <check name="test" conclusion="success" url="..."/>
  </checks>
  <merge-conflicts present="true|false"/>
  <reviews>
    <review author="<login>" mode="bot"
            state="pending|commented|approved|changes_requested|dismissed"/>
    <review author="<login>" mode="human" role="operator|team"
            state="pending|commented|approved|changes_requested|dismissed"/>
  </reviews>
  <comments>
    <comment id="<comment-id>" actionable="true"  cache="<abs-path>"/>
    <comment id="<comment-id>" actionable="false" cache="<abs-path>">
      <summary>1–3-sentence summary.</summary>
      <reactions>
        <reaction author="<login>" emoji="+1"/>
        <reaction author="<login>" emoji="rocket"/>
      </reactions>
    </comment>
  </comments>
  <threads>
    <thread id="<thread-id>" actionable="true"  cache="<abs-path>"/>
    <thread id="<thread-id>" actionable="false" cache="<abs-path>">
      <summary>1–3-sentence summary.</summary>
    </thread>
  </threads>
  <annotations>
    <annotation id="<annotation-id>" actionable="true"  cache="<abs-path>"/>
    <annotation id="<annotation-id>" actionable="false" cache="<abs-path>">
      <summary>1–3-sentence summary.</summary>
    </annotation>
  </annotations>
</pr-status>
```

### `<pr-status>` root element

| Attribute | Type   | Requirement | Meaning                                   |
| --------- | ------ | ----------- | ----------------------------------------- |
| `repo`    | string | REQUIRED    | Repository in `<owner>/<repo>` form       |
| `pr`      | int    | REQUIRED    | Pull request number                       |
| `head`    | string | REQUIRED    | Current head branch name or commit SHA    |

### `<terminal>`

Resolves whether the PR's change has **shipped** — independent of how (or by
whom) it landed. Emitted exactly once, as the first child of `<pr-status>`.

| Attribute   | Type                            | Requirement | Meaning                                                                 |
| ----------- | ------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `state`     | `open\|draft\|shipped\|abandoned` | REQUIRED  | Resolved lifecycle terminal; see resolution rules below                 |
| `gh-merged` | `true\|false`                   | REQUIRED    | Whether the platform itself marked the PR merged (`state==MERGED` / `mergedAt` set) |
| `ahead-by`  | `0\|<n>\|-`                     | REQUIRED    | `ahead_by` from the base…head three-dot compare; `-` when not computed  |

`open` and `draft` are **non-terminal** (the PR is still live; `draft` iff the
platform reports the PR as a draft). `shipped` and `abandoned` are **terminal**,
emitted only once the PR is closed.

**Resolution rules** (evaluated in order; first match wins). The intent is
binary: *the change is shipped iff it is present in base, regardless of merge
mechanism.* Steps are ordered cheapest-first; an implementation MUST NOT touch
git before the final step.

1. PR still open → `open` (or `draft` if the platform marks it draft). No
   further work.
2. `gh-merged` → `shipped`. (Platform-recorded merge; API only.)
3. Closed without `gh-merged`, and the base…head three-dot compare reports
   `ahead_by == 0` → `shipped`. Every head commit is already reachable from
   base (plain merge, fast-forward, or a merge-queue close where the platform
   never set merged). API only; the compare MUST accept the head **SHA** so it
   works even after the head branch is deleted.
4. Closed, `ahead_by > 0` → a **content check**: build the PR's combined net
   patch (`merge-base(base,head)…head`) and reverse-apply it against the base
   tip. Reverse-applies cleanly → the content is present → `shipped`; otherwise
   → `abandoned`. This is squash/rebase-safe (n→1 squashes and rebase rewrites
   match by combined content, which per-commit patch-id matching would miss).
   An empty net patch (no-op PR) reverse-applies trivially → `shipped`.

If the content check in step 4 cannot run (no repository available, fetch
fails), the implementation MUST NOT guess: it emits `state="abandoned"` with an
`error` attribute breadcrumb (e.g. `error="content-check-unavailable"`) so a
human can reconcile rather than risk a false claim of delivery.

| Attribute | Type   | Requirement | Meaning                                                              |
| --------- | ------ | ----------- | -------------------------------------------------------------------- |
| `error`   | string | OPTIONAL    | Present iff a terminal could not be resolved cleanly; carries a diagnostic breadcrumb and forces `state="abandoned"` |

### `<checks>`

| Attribute | Type                        | Requirement | Meaning                                                      |
| --------- | --------------------------- | ----------- | ------------------------------------------------------------ |
| `state`   | `passing\|failing\|pending` | REQUIRED    | Rollup: see rules below                                      |

**Rollup rules** (evaluated in order; first match wins):

1. `pending` — one or more checks are in-progress AND not `stuck`.
2. `failing` — one or more checks have a failure conclusion AND are not
   `informational`, AND no non-stuck check is in progress.
3. `passing` — all other cases.

Each child `<check>` element MUST carry:

| Attribute       | Type          | Requirement | Meaning                                                              |
| --------------- | ------------- | ----------- | -------------------------------------------------------------------- |
| `name`          | string        | REQUIRED    | Check name as reported by the platform                               |
| `conclusion`    | string        | REQUIRED    | Platform conclusion value, unmodified                                |
| `url`           | string        | REQUIRED    | URL to the check's detail page                                       |
| `informational` | `true\|false` | OPTIONAL    | Default `false`. Failures from informational checks do not contribute to `failing` rollup. Set from configuration. |
| `stuck`         | `true\|false` | OPTIONAL    | Default `false`. A check pending beyond the configured timeout is marked stuck; stuck checks do not contribute to `pending` rollup. |

The set of informational checks and the stuck-pending timeout are
implementation-defined configuration, not prescribed by this protocol.

### `<merge-conflicts>`

| Attribute | Type          | Requirement | Meaning                                               |
| --------- | ------------- | ----------- | ----------------------------------------------------- |
| `present` | `true\|false` | REQUIRED    | `true` iff the PR cannot merge due to conflicts       |

### `<reviews>`

One persistent `<review>` element per reviewer — not one per submitted review.
A reviewer who has been requested OR has submitted at least one review appears
exactly once. The script MUST deduplicate by reviewer (case-insensitive on
`author`), collapsing a reviewer's history to a single element whose `state`
reflects their current standing.

| Attribute | Type                                                          | Requirement                                    | Meaning                                              |
| --------- | ------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `author`  | string                                                        | REQUIRED                                       | Platform login of the reviewer                       |
| `mode`    | `bot\|human`                                                  | REQUIRED                                       | See §Mode classification below                       |
| `role`    | `operator\|team`                                              | REQUIRED when `mode="human"`; absent otherwise | Operator vs team classification of a human reviewer  |
| `state`   | `pending\|commented\|approved\|changes_requested\|dismissed` | REQUIRED                                       | Reviewer's current standing — see rules below        |

**State derivation rule.** For each reviewer, `state` is computed as follows:

1. Start from the reviewer's most recent submitted review state (normalized:
   `commented`, `approved`, `changes_requested`, or `dismissed`). A reviewer who
   was requested but has never submitted a review starts at `pending`.
2. **Outstanding-request override.** If the reviewer currently has an
   outstanding review request, `state` MUST be `pending` regardless of any prior
   verdict. A fresh request replaces the reviewer's previous review until they
   re-review — so a re-requested bot (e.g. a Copilot re-review) or an operator
   re-requested after approving reads `pending` again until the new review lands.

`state="pending"` is the in-flight signal: the request is outstanding and that
reviewer's review has not landed yet. An empty or stable inline-thread set while
a review is `pending` is NOT convergence.

**Role classification rule.** For each `<review mode="human">`: emit
`role="operator"` iff `author` matches the supplied operator identity
(case-insensitive); else `role="team"`. The operator identity input is
described in §Operator identity below. The classifier MUST NOT emit `role` on
`mode="bot"` reviews.

### `<comments>`

Every top-level PR comment MUST appear. Top-level PR comments are the flat
chronological stream on the PR, distinct from inline review threads.

For `actionable="true"` elements: the `<summary>` child element MUST be absent.
For `actionable="false"` elements: `<summary>` MUST be present with 1–3 sentences.

| Attribute    | Type          | Requirement | Meaning                                        |
| ------------ | ------------- | ----------- | ---------------------------------------------- |
| `id`         | string        | REQUIRED    | Platform-stable comment ID                     |
| `actionable` | `true\|false` | REQUIRED    | Whether the agent must act on this comment     |
| `cache`      | abs-path      | REQUIRED    | Absolute path to the `comments/<id>.md` file   |

#### `<reactions>` (top-level comments only)

Top-level `<comment>` elements MUST surface their platform reactions verbatim
as a `<reactions>` child containing one `<reaction>` element per reaction.
This enables agents to evaluate reaction-based approval signals (e.g. Gate 6
in the Delivery Protocol) from the XML alone, without an additional API
round-trip.

The `<reactions>` element MAY be omitted when there are no reactions. Order is
platform-defined and not significant. Reactions are surfaced for top-level
comments only; `<thread>` and `<annotation>` elements do NOT carry
`<reactions>` children in this revision.

| Attribute | Type   | Requirement | Meaning                                                                                                          |
| --------- | ------ | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `author`  | string | REQUIRED    | Platform login of the reactor                                                                                    |
| `emoji`   | string | REQUIRED    | Platform-normalized reaction name: `+1`, `-1`, `laugh`, `heart`, `hooray`, `confused`, `rocket`, `eyes`           |

### `<threads>` and `<annotations>`

Every inline review thread and annotation present on the PR MUST appear,
regardless of actionability.

For `actionable="true"` elements: `<summary>` MUST be absent.
For `actionable="false"` elements: `<summary>` MUST be present with 1–3 sentences.

| Attribute    | Type          | Requirement | Meaning                                    |
| ------------ | ------------- | ----------- | ------------------------------------------ |
| `id`         | string        | REQUIRED    | Platform-stable thread or annotation ID    |
| `actionable` | `true\|false` | REQUIRED    | Whether the agent must act on this item    |
| `cache`      | abs-path      | REQUIRED    | Absolute path to the `.md` cache file      |

## Actionability rules

### Top-level comments and threads

Actionability follows §2.1.2 §"Thread-aware filtering" verbatim. An item is
**non-actionable** iff any of the following holds:

- The newest comment was written by the calling agent AND carries a terminal
  signal (a terminal reaction on platforms with reaction support, or a terminal
  text token on platforms without).
- The platform has explicitly resolved the thread (review threads only; top-level
  comments have no platform resolution mechanism).
- The comment is an **agent artifact** authored by the calling agent — one
  carrying a line-anchored agent-artifact sentinel such as the Delivery
  Protocol's plan comment (`<!-- agent-plan:<agent-id> -->`) or engagement
  comment (`<!-- agent-engagement:<agent-id> -->`). These are the agent's own
  working/soliciting comments, never reviewer items the agent must "address,"
  so they MUST classify as non-actionable regardless of terminal signal. The
  author-identity match is load-bearing: a human quoting one of these sentinels
  stays actionable. (The set of recognized artifact sentinels is defined by the
  consuming protocol, e.g. §2.4; this protocol only fixes the
  author-match + line-anchored-sentinel classification rule.)

Otherwise the item is **actionable**. In particular, a reviewer reply to an
agent's previous turn makes the item actionable.

### Annotations

An annotation is **actionable** by default.

An annotation is **non-actionable** iff `annotations/<annotation-id>.ack`
exists in the cache directory.

Writing the `.ack` marker is the calling agent's responsibility, not the
script's. The script MUST NOT create `.ack` files.

## Summaries

Summaries for non-actionable items MUST be:

- 1–3 sentences describing the outcome of the comment, thread, or annotation.
- Stored at `<id>.summary.md` alongside the corresponding `<id>.md` cache file.

### Regeneration rules

The script MUST apply the following rules in order:

1. If `<id>.md` does not exist: write it, generate a summary, write
   `<id>.summary.md`.
2. If `<id>.md` exists and its content has not changed since the last run:
   reuse the existing `<id>.summary.md` without regenerating.
3. If `<id>.md` exists and its content has changed: overwrite `<id>.md`,
   regenerate the summary, overwrite `<id>.summary.md`.

The script SHOULD detect "content has not changed" with a stored content hash
rather than a full byte-for-byte read on every run. The exact mechanism is
implementation-defined.

## Mode classification

The `mode` attribute on `<review>` follows the §2.1.2 Mode A predicate:

- `bot` iff the platform classifies the account as a bot or service identity,
  OR the account identifier matches at least one of the following patterns
  (evaluated case-insensitively): `*copilot*`, `*codex*`, `*claude*`,
  `*ai-agent*`.
- `human` otherwise.

**Default: `human`.** On uncertainty, the script MUST emit `mode="human"`.

## Calling agent identity

Item actionability requires knowing which agent invoked the script so the
script can identify that agent's posts via the `<!-- agent-reply:<agent-id> -->`
machine marker (or its platform equivalent).

The calling agent MUST supply its identity when invoking the script. The
mechanism — environment variable, CLI flag, or configuration file — is
implementation-defined, but the script MUST NOT fall back to a default identity
when none is supplied; it MUST fail with an error instead.

## Operator identity

Classifying `<review mode="human">` elements with `role="operator"` vs
`role="team"` (see §`<reviews>`) requires knowing which account is the operator
directing the calling agent.

The calling agent MUST supply an operator identity when invoking the script.
The mechanism mirrors §Calling agent identity — an implementation-defined
input (environment variable, CLI flag, or configuration file). When the
operator identity is missing, the script MUST NOT default it (for example, to
the agent's own identity or to "no operator"); it MUST fail with an error.

The classifier compares logins case-insensitively. An agent with no
explicitly configured operator MAY supply a derived identity (for example, the
ticket assigner from a linked tracker); the protocol is agnostic to how the
calling agent obtains the value, only that it supplies one.
