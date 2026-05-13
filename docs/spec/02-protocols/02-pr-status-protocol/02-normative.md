# §2.2.2 — PR Status Protocol: Normative

## Scope

The protocol covers:

- the XML document a status script emits to stdout
- the on-disk cache the script populates
- the rules a script uses to classify threads, reviews, and annotations

It does not cover the names, language, or runtime of scripts that implement it,
nor the specific platform APIs queried to gather the underlying data.

## Cache layout

The per-PR cache root is:

```
<base>/<skill>/<repo-slug>/<pr-number>/
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
- `<thread-id>` and `<annotation-id>` are platform-stable identifiers (e.g.
  GitHub's `node_id`). They MUST be filename-safe; substitute or escape any
  path-unsafe characters.

### Cache files

| Path                        | Contents                                                           |
| --------------------------- | ------------------------------------------------------------------ |
| `threads/<id>.md`           | Verbatim thread content, oldest comment first                      |
| `threads/<id>.summary.md`   | 1–3-sentence model summary; present iff thread is non-actionable  |
| `annotations/<id>.md`       | Verbatim annotation body                                           |
| `annotations/<id>.summary.md` | 1–3-sentence model summary; present iff annotation non-actionable |
| `annotations/<id>.ack`      | Empty marker file; presence means annotation is non-actionable     |

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
    <check name="lint" conclusion="failure" url="..."/>
    <check name="test" conclusion="success" url="..."/>
  </checks>
  <merge-conflicts present="true|false"/>
  <reviews>
    <review author="<login>" mode="bot|human"
            state="commented|approved|changes_requested|dismissed"/>
  </reviews>
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
| `state`   | `passing\|failing\|pending` | REQUIRED    | Rollup: `failing` if any check failed; `pending` if any in-progress and none failed; `passing` otherwise |

Each child `<check>` element MUST carry:

| Attribute    | Type   | Requirement | Meaning                                 |
| ------------ | ------ | ----------- | --------------------------------------- |
| `name`       | string | REQUIRED    | Check name as reported by the platform  |
| `conclusion` | string | REQUIRED    | Platform conclusion value, unmodified   |
| `url`        | string | REQUIRED    | URL to the check's detail page          |

### `<merge-conflicts>`

| Attribute | Type          | Requirement | Meaning                                               |
| --------- | ------------- | ----------- | ----------------------------------------------------- |
| `present` | `true\|false` | REQUIRED    | `true` iff the PR cannot merge due to conflicts       |

### `<reviews>`

One `<review>` element per submitted review. The script MUST emit all submitted
reviews; it MUST NOT deduplicate by reviewer.

| Attribute | Type                                                    | Requirement | Meaning                                     |
| --------- | ------------------------------------------------------- | ----------- | ------------------------------------------- |
| `author`  | string                                                  | REQUIRED    | Platform login of the reviewer              |
| `mode`    | `bot\|human`                                            | REQUIRED    | See §Mode classification below              |
| `state`   | `commented\|approved\|changes_requested\|dismissed`    | REQUIRED    | Platform review state, normalized           |

### `<threads>` and `<annotations>`

Every thread and annotation present on the PR MUST appear in the output,
regardless of actionability.

For `actionable="true"` elements:
- The `<summary>` child element MUST be absent.
- The `cache` attribute MUST point to the `.md` cache file.

For `actionable="false"` elements:
- The `<summary>` child element MUST be present and contain 1–3 sentences.
- The `cache` attribute MUST point to the `.md` cache file.

| Attribute    | Type          | Requirement | Meaning                                    |
| ------------ | ------------- | ----------- | ------------------------------------------ |
| `id`         | string        | REQUIRED    | Platform-stable thread or annotation ID    |
| `actionable` | `true\|false` | REQUIRED    | Whether the agent must act on this item    |
| `cache`      | abs-path      | REQUIRED    | Absolute path to the `.md` cache file      |

## Actionability rules

### Threads

Thread actionability follows §2.1.2 §"Thread-aware filtering" verbatim. A thread
is **non-actionable** iff either of the following holds:

- The newest comment in the thread was written by the calling agent AND carries
  a terminal signal (a terminal reaction on platforms with reaction support, or
  a terminal text token on platforms without).
- The platform has explicitly resolved the thread.

Otherwise the thread is **actionable**. In particular, a human reply to an
agent's previous turn makes the thread actionable.

### Annotations

Annotations have no platform-level acknowledgement mechanism.

An annotation is **actionable** by default.

An annotation is **non-actionable** iff `annotations/<annotation-id>.ack`
exists in the cache directory.

Writing the `.ack` marker is the calling agent's responsibility, not the
script's. The script MUST NOT create `.ack` files.

## Summaries

Summaries for non-actionable items MUST be:

- 1–3 sentences describing the outcome of the thread or annotation.
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

The `mode` attribute on `<review>` — and on any future author-bearing element —
follows the §2.1.2 Mode A predicate:

- `bot` iff the platform classifies the account as a bot or service identity,
  OR the account identifier matches at least one of the following patterns
  (evaluated case-insensitively): `*copilot*`, `*codex*`, `*claude*`,
  `*ai-agent*`.
- `human` otherwise.

**Default: `human`.** On uncertainty, the script MUST emit `mode="human"`.

## Calling agent identity

Thread actionability requires knowing which agent invoked the script so the
script can identify that agent's posts via the `<!-- agent-reply:<agent-id> -->`
machine marker (or its platform equivalent).

The calling agent MUST supply its identity when invoking the script. The
mechanism — environment variable, CLI flag, or configuration file — is
implementation-defined, but the script MUST NOT fall back to a default identity
when none is supplied; it MUST fail with an error instead.
