# §2.2.2 — PR Status Protocol: Normative

## Scope

The protocol covers:

- the XML document `dispatch pr-status` emits to stdout
- the on-disk cache it populates
- the rules it uses to classify comments, threads, reviews, and annotations

It does not cover the specific platform APIs queried to gather the underlying
data.

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
  <checks state="passing|failing|pending">
    <check name="lint" conclusion="failure" url="..." informational="false" stuck="false"/>
    <check name="test" conclusion="success" url="..."/>
  </checks>
  <merge-conflicts present="true|false"/>
  <reviews>
    <review author="<login>" mode="bot|human"
            state="commented|approved|changes_requested|dismissed"/>
  </reviews>
  <comments>
    <comment id="<comment-id>" actionable="true"  cache="<abs-path>"/>
    <comment id="<comment-id>" actionable="false" cache="<abs-path>">
      <summary>1–3-sentence summary.</summary>
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

One `<review>` element per submitted review. The script MUST emit all submitted
reviews; it MUST NOT deduplicate by reviewer.

| Attribute | Type                                                  | Requirement | Meaning                             |
| --------- | ----------------------------------------------------- | ----------- | ----------------------------------- |
| `author`  | string                                                | REQUIRED    | Platform login of the reviewer      |
| `mode`    | `bot\|human`                                          | REQUIRED    | See §Mode classification below      |
| `state`   | `commented\|approved\|changes_requested\|dismissed`   | REQUIRED    | Platform review state, normalized   |

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
**non-actionable** iff either of the following holds:

- The newest comment was written by the calling agent AND carries a terminal
  signal (a terminal reaction on platforms with reaction support, or a terminal
  text token on platforms without).
- The platform has explicitly resolved the thread (review threads only; top-level
  comments have no platform resolution mechanism).

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
