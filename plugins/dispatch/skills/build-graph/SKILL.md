---
name: build-graph
description: Build the project dependency graph a tracker holds — write tasks, milestones, and dependencies through the dispatch graph CLI. Use when asked to build, refresh, or update a project graph.
---

# build-graph

Produce the **project-graph**.

**You fetch. The CLI reasons.** Effective blocking, ranking, cycle detection, and
milestone gating are `dispatch graph`'s job. Never derive them yourself; never
hand-edit the graph. Reading the graph and dispatching workers belong to
higher-level skills, not this one.

## The loop

1. **Load the augmentation.** Read the `build-<tracker>-graph` skill for the
   tracker (`build-linear-graph` for Linear) — it supplies the tools, the field
   mapping, and the cursor. Without one, drive the tracker's MCP server directly
   and map its fields onto the flags below yourself.
2. **Read the cursor** — `dispatch graph cursor --source <tracker>`. Empty output
   means first run: `dispatch graph reset`, then a full sync. Otherwise fetch only
   what changed since it.
3. **Fetch** the selected projects: tasks, milestones, dependencies.
4. **Write** each item with one command (a bad one fails only itself):

   ```shell
   dispatch graph project set   --id P --name "…"
   dispatch graph milestone set --id M1 --project P --name "M1"
   dispatch graph task set      --id CLC-945 --project P --role in-progress \
       [--milestone M1] [--priority 2] [--url U] [--title T] [--labels a,b]
   dispatch graph edge add      --blocker CLC-944 --blocked CLC-945
   ```

5. **Store the cursor** — `dispatch graph cursor --source <tracker> --set <token>`.

## Writing rules

- **You map the state; the CLI knows only the protocol.** `--role` takes a
  normalized role (`backlog`, `paused`, `awaiting-external`, `available`,
  `in-progress`, `in-review`, `finished`, `delivered`, `verified`, `canceled`).
  The augmentation skill carries the tracker's state→role table and the rule
  for a state it does not cover: map it only when its lifecycle meaning is
  unambiguous, otherwise escalate to the operator. Never guess a role. Labels
  pass through natively — the CLI derives target-kind and human-interactive
  from `--labels` plus config.
- **Milestones are sequenced with edges, not an order.** `edge add --blocker M1
  --blocked M2` means M2's work waits on M1; a milestone can have several
  predecessors. A task joins a milestone with `task set --milestone M1`.
- **Redeclare a direction with `edge set`.** After re-fetching a task's blockers,
  `edge set --blocked CLC-945 --blockers a,b` makes them exactly `{a,b}` in one
  call (empty clears them). Use it instead of diffing; `edge add`/`edge rm` are
  for single changes.
- **An edge that would close a cycle is refused** (exit 4). Fix the direction, or
  remove the opposing edge first.
- **A delta writes only what changed.** A task you don't touch keeps its state.
  Drop a task with `task rm` only when the fetch shows it gone. A deletion the
  delta cannot see is cleaned by a full rebuild, and `reset` is never your call
  to make: run it exactly when the cursor is empty (first run) or the caller
  explicitly asks for a rebuild.

Full flags and exit codes: [`reference.md`](./reference.md).
