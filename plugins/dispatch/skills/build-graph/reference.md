# build-graph — reference

## Commands

| Command                                               | Does                                                     |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `graph project set --id P [--name N]`                 | Declare a project (only declared projects go terminal).  |
| `graph project rm --id P`                             | Forget a project; its tasks are left alone.              |
| `graph task set --id T --project P --role R [flags]`  | Upsert a task (see below).                               |
| `graph task rm --id T`                                | Delete a task, its edges, and any claim.                 |
| `graph milestone set --id M --project P [--name N]`   | Upsert a milestone.                                      |
| `graph milestone rm --id M`                           | Delete a milestone, its edges, and its review.           |
| `graph milestone show --id M`                         | Print one milestone's gate state and member nodes.       |
| `graph edge add --blocker B --blocked D`              | `B` blocks `D` — `D` depends on `B`.                     |
| `graph edge rm --blocker B --blocked D`               | Remove one edge.                                         |
| `graph edge set --blocked D --blockers a,b`           | Replace all of `D`'s blockers. Empty list clears them.   |
| `graph edge set --blocker B --blocks a,b`             | Replace all of `B`'s blocked. Empty list clears them.    |
| `graph cursor [--source S] [--set token \| --clear]`  | Read, set, or clear the sync cursor.                     |
| `graph reset`                                         | Wipe the graph (keeps claims, reviews, cursors).         |

`task set` flags: `--milestone <id>`, `--priority <n>` (lower = more urgent; omit
if none), `--url`, `--title`, `--labels a,b`, `--branch-hint`, `--updated-at <ts>`
(RFC 3339; anything unparseable fails), `--injected` (rank to the top of the
frontier). `--role` takes a normalized protocol role — the caller does the
tracker-state mapping.

Edge endpoints may be tasks or milestones. Two tasks form a dependency; two
milestones form sequencing; an edge that would join a task to a milestone is
refused (attach a task with `--milestone` instead). An edge may name an id that
has not been written yet — it holds its dependents blocked until the id is
written.

## Exit codes

| Code | Means                   | Do                                          |
| ---- | ----------------------- | ------------------------------------------- |
| 0    | success                 | —                                           |
| 1    | a bug in the CLI        | report it; retrying will not help           |
| 2    | called wrong            | fix the invocation                          |
| 3    | the environment refused | retry (a live claim held by another is 3)   |
| 4    | bad data                | fix the input, then re-run                  |

Every failure prints `error:` and a `hint:` line saying what to change.
