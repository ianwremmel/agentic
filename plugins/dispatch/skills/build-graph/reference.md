# build-graph — reference

## Commands

Every command takes `--db <path>` (default `$DISPATCH_GRAPH_DB`, else
`$XDG_STATE_HOME/dispatch/graph.db`) and `--config <path>`.

### Writing the graph

| Command                                                       | Does                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| `graph project set --id P [--name N]`                         | Declare a project (only declared projects go terminal).  |
| `graph project rm --id P`                                     | Forget a project; its tasks are left alone.              |
| `graph task set --id T --project P --state S [flags]`         | Upsert a task (see below).                               |
| `graph task rm --id T`                                        | Delete a task, its edges, and any claim.                 |
| `graph milestone set --id M --project P [--name N]`           | Upsert a milestone.                                      |
| `graph milestone rm --id M`                                   | Delete a milestone and its edges.                        |
| `graph edge add --blocker B --blocked D`                      | `B` blocks `D` — `D` depends on `B` (§2.3).             |
| `graph edge rm --blocker B --blocked D`                       | Remove one edge.                                         |
| `graph edge set --blocked D --blockers a,b`                   | Replace all of `D`'s blockers. Empty list clears them.   |
| `graph edge set --blocker B --blocks a,b`                     | Replace all of `B`'s blocked. Empty list clears them.    |
| `graph reset`                                                 | Wipe the graph (keeps claims, reviews, cursors).         |

`task set` flags: `--milestone <id>`, `--priority <n>` (lower = more urgent; omit
if none), `--url`, `--title`, `--labels a,b`, `--branch-hint`, `--updated-at <ts>`,
`--injected` (rank to the top of the frontier, §2.6), `--tracker <name>` (default
`linear`, selects the state mapping).

Edge endpoints may be tasks or milestones. Two tasks form a dependency; two
milestones form sequencing; a task-and-milestone edge is surfaced as an anomaly
(attach a task with `--milestone` instead).

### Reading and coordinating

| Command                                              | Does                                                    |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `graph doc [--format xml\|json] [--stale-after D]`   | Emit the derived project-graph document.                |
| `graph next [--project P] [--stale-after D]`         | Print the top available task, or nothing.               |
| `graph next --claim --agent A [--stale-after D]`     | Atomically grab and claim the top available task.       |
| `graph claim --id T --agent A [--stale-after D]`     | Claim `T`, or reclaim it if the holder's claim is stale. |
| `graph heartbeat --id T --agent A`                   | Refresh your claim so it does not go stale.             |
| `graph release --id T --agent A`                     | Release your claim (idempotent).                        |
| `graph record-review --id M [--at ts]`               | Record that milestone `M`'s §2.3 review ran.            |
| `graph cursor [--source S] [--set token \| --clear]` | Read, set, or clear the sync cursor.                    |

`--stale-after` takes a duration (`10m`, `30s`, `2h`); default is the config's
`claimStaleAfter`, else 10m. It is read by `doc`, `next`, and `claim` — the
commands that decide whether a claim still holds.

`next` prints one logfmt line (`id=… target-kind=… url=… branch-hint=…`) or
nothing when the frontier is empty; empty output with exit 0 is "no work now".

## Exit codes

| Code | Means                   | Do                                          |
| ---- | ----------------------- | ------------------------------------------- |
| 0    | success                 | —                                           |
| 1    | a bug in the CLI        | report it; retrying will not help           |
| 2    | called wrong            | fix the invocation                          |
| 3    | the environment refused | retry (a live claim held by another is 3)   |
| 4    | bad data                | fix the input, then re-run                  |

Every failure prints `error:` and a `hint:` line saying what to change.

## Config

`--config <path>`, else `$DISPATCH_GRAPH_CONFIG`, else `./.dispatch/graph.json`
if it exists. All keys optional:

```json
{
  "states": {"Ready for QA": "in-review"},
  "humanInteractiveLabels": ["human-only", "needs-human"],
  "verificationLabels": ["verification"],
  "parkedRoles": ["awaiting-external", "paused"],
  "claimStaleAfter": "10m"
}
```

`states` maps a native tracker state onto a protocol role, overriding the built-in
table (§2.3 team override). The label lists derive a task's target-kind and
human-interactive flag.
