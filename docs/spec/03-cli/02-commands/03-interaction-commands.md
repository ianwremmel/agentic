# §3.2.3 — Interaction Commands: Normative

Interaction commands are invoked by agent sessions to perform platform writes
and reads in compliance with §2.1 and §2.2. They are available as CLI commands
so any runner can use them without a language-specific SDK dependency.

All commands exit 0 on success and non-zero on error.

---

## `dispatch create-comment`

Post a new top-level comment on a PR or ticket, applying the §2.1 wire format.

```shell
dispatch create-comment \
    --repo <owner/repo> \
    (--pr <number> | --issue <number>) \
    --body <text> \
    --agent-id <id>
```

| Flag         | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| `--repo`     | Repository in `<owner>/<repo>` form. REQUIRED.                   |
| `--pr`       | PR number. Mutually exclusive with `--issue`.                    |
| `--issue`    | Issue number. Mutually exclusive with `--pr`.                    |
| `--body`     | Comment body (opaque to the command). REQUIRED.                  |
| `--agent-id` | Agent identifier placed in the machine marker. REQUIRED.         |

The command automatically prepends the machine marker (`<!-- agent-reply:<id> -->`)
and applies the Mode B sparkle wrapper when the authenticated account is
human-credentialed per §2.1.2 §Mode detection. The caller MUST NOT include the
marker or sparkle wrapper in `--body`.

Exits non-zero if the target does not exist, credentials are insufficient, or
mode detection fails with no default.

---

## `dispatch reply-to-thread`

Post a reply in an existing PR review thread or ticket comment thread.

```shell
dispatch reply-to-thread \
    --repo <owner/repo> \
    --thread-id <id> \
    --body <text> \
    --agent-id <id>
```

| Flag          | Meaning                                                           |
| ------------- | ----------------------------------------------------------------- |
| `--repo`      | Repository in `<owner>/<repo>` form. REQUIRED.                    |
| `--thread-id` | Platform-stable thread identifier. REQUIRED.                      |
| `--body`      | Reply body. REQUIRED.                                             |
| `--agent-id`  | Agent identifier placed in the machine marker. REQUIRED.          |

Applies §2.1 wire format identically to `create-comment`.

---

## `dispatch react`

Add a reaction to a comment.

```shell
dispatch react \
    --repo <owner/repo> \
    --comment-id <id> \
    --reaction (+1 | -1 | rocket | eyes)
```

| Flag           | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| `--repo`       | Repository in `<owner>/<repo>` form. REQUIRED.        |
| `--comment-id` | Platform-stable comment identifier. REQUIRED.         |
| `--reaction`   | One of `+1`, `-1`, `rocket`, `eyes`. REQUIRED.        |

Reactions carry no body and require neither machine marker nor sparkle wrapper
per §2.1.2 §Writing rules. The command MUST NOT add them.

---

## `dispatch request-review`

Request a review on a PR.

```shell
dispatch request-review \
    --repo <owner/repo> \
    --pr <number> \
    --reviewer <login> \
    [--reviewer <login> ...]
```

| Flag         | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `--repo`     | Repository in `<owner>/<repo>` form. REQUIRED.                          |
| `--pr`       | PR number. REQUIRED.                                                    |
| `--reviewer` | Login to request. May be repeated. At least one REQUIRED.               |

The command MUST enforce §2.1.2 §Review rules: it MUST refuse to request a
review from the authenticated account itself. Exits non-zero if any reviewer is
the authenticated account.

On platforms where review-request from the current account is restricted (Mode B,
GitHub), the command MUST surface an actionable error message.

---

## `dispatch pr-status`

Emit the §2.2 XML document for a PR and update the disk cache.

```shell
dispatch pr-status \
    --repo <owner/repo> \
    --pr <number> \
    --agent-id <id> \
    [--skill <skill>]
```

| Flag         | Meaning                                                                            |
| ------------ | ---------------------------------------------------------------------------------- |
| `--repo`     | Repository in `<owner>/<repo>` form. REQUIRED.                                     |
| `--pr`       | PR number. REQUIRED.                                                               |
| `--agent-id` | Calling agent's identity, used to classify item actionability. REQUIRED.           |
| `--skill`    | Skill name used as the cache namespace. Defaults to the agent ID if omitted.       |

Behavior per §2.2.2. Emits the `<pr-status>` XML document on stdout. Populates
and updates the disk cache. Exits non-zero if the PR does not exist or credentials
are insufficient.

---

## `dispatch ack-annotation`

Mark an annotation as non-actionable by writing the §2.2 `.ack` marker.

```shell
dispatch ack-annotation \
    --repo <owner/repo> \
    --pr <number> \
    --annotation-id <id> \
    [--skill <skill>]
```

| Flag              | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `--repo`          | Repository in `<owner>/<repo>` form. REQUIRED.                      |
| `--pr`            | PR number. REQUIRED.                                                |
| `--annotation-id` | Platform-stable annotation identifier. REQUIRED.                    |
| `--skill`         | Skill name used as the cache namespace. Defaults to the agent ID.   |

Creates `annotations/<annotation-id>.ack` in the §2.2 cache directory for the
given PR. Exits non-zero if the cache directory does not exist (run
`pr-status` first).
