# §3.2.2 — Commands: Normative

All `dispatch` commands exit 0 on success and non-zero on error. Errors are
written to stderr; structured output is written to stdout.

---

## Daemon commands

### `dispatch daemon start`

Start the daemon process.

```
dispatch daemon start [--foreground]
```

| Flag          | Meaning                                         |
| ------------- | ----------------------------------------------- |
| `--foreground` | Run in the foreground; do not detach from TTY.  |

Behavior per §3.1.2 §Lifecycle §Start. Exits non-zero if the PID lock is held
by a live process or if a required CLI is missing or unauthenticated.

### `dispatch daemon stop`

Stop the daemon process.

```
dispatch daemon stop [--force]
```

| Flag      | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| `--force` | Send SIGTERM immediately without waiting for in-flight runners.      |

Behavior per §3.1.2 §Lifecycle §Stop.

### `dispatch daemon status`

Print a summary of the daemon state.

```
dispatch daemon status
```

Prints one line per task (id, current role, last heartbeat, live runner PID or
`-`) plus daemon-wide counters: events handled, runners spawned, watch handles
alive, pending follow-ups. Exits non-zero if the daemon is not running.

---

## Prompt commands

### `dispatch prompts list`

List all event kinds and show which template wins for each.

```
dispatch prompts list
```

Output columns: event kind, winning source (`repo` / `user` / `built-in`), path
of the winning template.

### `dispatch prompts copy`

Copy the built-in default for an event to the repo or user override location.

```
dispatch prompts copy <event> (--repo | --home)
```

| Flag     | Destination                                           |
| -------- | ----------------------------------------------------- |
| `--repo` | `<cwd>/.dispatch/prompts/<event>.xml`                 |
| `--home` | `~/.config/dispatch/prompts/<event>.xml`              |

Writes the bundled default template to the override location. Exits non-zero if
the event kind is unknown or the target file already exists (use `--force` to
overwrite).

### `dispatch prompts diff`

Show the diff between the active override and the built-in default.

```
dispatch prompts diff <event>
```

Prints a unified diff. Exits 0 whether or not differences exist; exits non-zero
if the event kind is unknown or no override exists.

---

## Task commands

### `dispatch tasks list`

List all tasks the daemon is monitoring.

```
dispatch tasks list
```

Output: one line per task with id, current role (from last heartbeat), and last
heartbeat timestamp.

### `dispatch tasks add`

Register a PR or ticket for the daemon to monitor.

```
dispatch tasks add <url>
```

`<url>` is a full URL to a GitHub PR or a supported ticket tracker issue. The
daemon creates a task record and immediately fires a `bootstrap` event if no
worktree exists. Exits non-zero if the URL is not recognized or the task already
exists.

### `dispatch tasks remove`

Stop monitoring a task.

```
dispatch tasks remove <url>
```

Terminates any live runner for the task (SIGTERM), removes the task record, and
removes the worktree if the daemon created it. The worktree is not removed if it
was not created by the daemon. Exits non-zero if the task is not found.

### `dispatch tasks show`

Show the full task record for a single task.

```
dispatch tasks show <url>
```

Prints the task record as JSON. Exits non-zero if the task is not found.

---

## Interaction commands

These commands are invoked by agent sessions to perform platform writes and reads
in compliance with §2.1 and §2.2.

### `dispatch create-comment`

Post a new top-level comment on a PR or ticket, applying the §2.1 wire format.

```
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

### `dispatch reply-to-thread`

Post a reply in an existing PR review thread or ticket comment thread.

```
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

### `dispatch react`

Add a reaction to a comment.

```
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

### `dispatch request-review`

Request a review on a PR.

```
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

### `dispatch pr-status`

Emit the §2.2 XML document for a PR and update the disk cache.

```
dispatch pr-status \
    --repo <owner/repo> \
    --pr <number> \
    --agent-id <id> \
    [--skill <skill>]
```

| Flag         | Meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| `--repo`     | Repository in `<owner>/<repo>` form. REQUIRED.                                           |
| `--pr`       | PR number. REQUIRED.                                                                     |
| `--agent-id` | Calling agent's identity, used to classify thread actionability. REQUIRED.               |
| `--skill`    | Skill name, used as the cache namespace. Defaults to the agent ID if omitted.            |

Behavior per §2.2.2. Emits the `<pr-status>` XML document on stdout. Populates
and updates the disk cache. Exits non-zero if the PR does not exist or
credentials are insufficient.

### `dispatch ack-annotation`

Mark an annotation as non-actionable by writing the §2.2 `.ack` marker.

```
dispatch ack-annotation \
    --repo <owner/repo> \
    --pr <number> \
    --annotation-id <id> \
    [--skill <skill>]
```

| Flag             | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `--repo`         | Repository in `<owner>/<repo>` form. REQUIRED.                       |
| `--pr`           | PR number. REQUIRED.                                                 |
| `--annotation-id`| Platform-stable annotation identifier. REQUIRED.                     |
| `--skill`        | Skill name used as the cache namespace. Defaults to the agent ID.    |

Creates `annotations/<annotation-id>.ack` in the §2.2 cache directory for the
given PR. Exits non-zero if the cache directory does not exist (run `pr-status`
first).
