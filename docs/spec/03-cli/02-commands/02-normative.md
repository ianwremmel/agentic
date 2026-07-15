# §3.2.2 — Commands: Normative (Daemon and Task Commands)

All `dispatch` commands exit 0 on success and non-zero on error. Errors are
written to stderr; structured output is written to stdout.

---

## Daemon commands

### `dispatch daemon start`

Start the daemon process.

```shell
dispatch daemon start [--foreground]
```

| Flag           | Meaning                                         |
| -------------- | ----------------------------------------------- |
| `--foreground` | Run in the foreground; do not detach from TTY.  |

Behavior per §3.1.2 §Lifecycle §Start. Exits non-zero if the PID lock is held
by a live process or if a required CLI is missing or unauthenticated.

### `dispatch daemon stop`

Stop the daemon process.

```shell
dispatch daemon stop [--force]
```

| Flag      | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| `--force` | Send SIGTERM immediately without waiting for in-flight runners.      |

Behavior per §3.1.2 §Lifecycle §Stop.

### `dispatch daemon status`

Print a summary of the daemon state.

```shell
dispatch daemon status
```

Prints one line per task (id, current role, last heartbeat, live runner PID or
`-`) plus daemon-wide counters: events handled, runners spawned, watch handles
alive, pending follow-ups. Exits non-zero if the daemon is not running.

---

## Prompt commands

### `dispatch prompts list`

List all event kinds and show which template wins for each.

```shell
dispatch prompts list
```

Output columns: event kind, winning source (`repo` / `user` / `built-in`), path
of the winning template.

### `dispatch prompts copy`

Copy the built-in default for an event to the repo or user override location.

```shell
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

```shell
dispatch prompts diff <event>
```

Prints a unified diff. Exits 0 whether or not differences exist; exits non-zero
if the event kind is unknown or no override exists.

---

## Task commands

Task commands that create a new task MUST launch the daemon automatically if it
is not running.

### `dispatch tasks list`

List all tasks the daemon is monitoring.

```shell
dispatch tasks list
```

Output: one line per task with id, current role (from last heartbeat), and last
heartbeat timestamp.

### `dispatch add-ticket`

Register a single ticket for the daemon to monitor and work on.

```shell
dispatch add-ticket <url-or-id>
```

`<url-or-id>` is a full URL or a tracker-native ID (e.g. `DEV-123`) for a
supported ticket tracker issue. The daemon creates a task record, creates the
worktree, and immediately fires a `bootstrap` event.

If the daemon is not running, it is started automatically before the task is
added. Exits non-zero if the ticket is not recognized or the task already exists.

### `dispatch add-project`

Register a project for the daemon to monitor. The daemon fetches the project's
dependency graph and determines which tickets to work on.

```shell
dispatch add-project <url-or-id>
```

`<url-or-id>` is a full URL or a tracker-native project identifier. The daemon
creates task records for eligible tickets (those in the `available` role with no
remaining blockers), creating worktrees and firing `bootstrap` events as needed.

If the daemon is not running, it is started automatically before the project is
added. Exits non-zero if the project is not recognized.

### `dispatch add-pr`

Register an existing pull request for the daemon to monitor.

```shell
dispatch add-pr <url>
```

`<url>` is a full URL to a GitHub PR. The daemon creates a task record and resumes
monitoring from the current PR state. The daemon MUST NOT open a new PR or create
a new empty commit for a task registered with `add-pr`.

If the daemon is not running, it is started automatically. Exits non-zero if the
PR URL is not recognized or the task already exists.

### `dispatch tasks remove`

Stop monitoring a task.

```shell
dispatch tasks remove <url-or-id>
```

Terminates any live runner for the task (SIGTERM), removes the task record, and
removes the worktree if the daemon created it. Worktrees not created by the
daemon are left alone. Exits non-zero if the task is not found.

### `dispatch tasks show`

Show the full task record for a single task.

```shell
dispatch tasks show <url-or-id>
```

Prints the task record as JSON. Exits non-zero if the task is not found.
