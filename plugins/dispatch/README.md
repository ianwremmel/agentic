# dispatch

> Claude Code plugin for dispatching engineering work across pull requests and [Linear.app](https://linear.app) projects.

Covers the full lifecycle: drafting PRs from a working branch, pushing and publishing, CI triage, responding to review comments, and merging — alongside Linear issue triage, project planning and breakdown, status updates, standups, and keeping Linear issues in sync with GitHub PRs. Skills, agents, and hooks are being migrated from a prior repo — this directory is scaffolding for now.

## Install

From inside Claude Code, after adding the `agentic` marketplace:

```shell
/plugin install dispatch@agentic
```

See the [root README](/README.md#install) for marketplace setup.

## Usage

Once installed, the plugin's skills appear under the `dispatch:` namespace. Run `/help` from inside Claude Code to list them.

## CLI

`bin/dispatch` is the entry point skills shell out to. Claude Code puts a
plugin's `bin/` on `PATH`, so a skill can call it by name:

```shell
dispatch greet --name World      # -> hello World
dispatch --help                  # list commands
```

`dispatch graph` builds, queries, and coordinates work over the project
dependency graph the `build-graph` skill produces — a SQLite-backed store
(`node:sqlite`) plus the derivation an orchestrator schedules from:

```shell
dispatch graph task set --id CLC-945 --project P --state "In Progress"  # typed writes
dispatch graph doc                                                      # the derived document
dispatch graph next --claim --agent <session-id>                        # grab the next task
```

A skill writes what it fetched through typed `project`/`task`/`edge`/`milestone`
commands; `doc` derives the document. Effective blocking, ranking, cycle
detection, and milestone gating are computed here rather than by the fetching
skill, so every consumer gets the same answer. `next` and the claim lifecycle
(`claim`/`heartbeat`/`release`) coordinate which agent works which task. See
[`skills/build-graph/reference.md`](skills/build-graph/reference.md).

It is a bash wrapper around `cli/main.mts`. The wrapper checks that Node is
present and at least 24.18 — the CLI ships as unbuilt TypeScript and relies on
Node's native type stripping, so there is no build step and no runtime
dependencies. `DISPATCH_NODE` picks a specific Node binary.

Structured output goes to stdout; logfmt records and error messages go to
stderr. `--log-level debug|info|warn|error` (or `DISPATCH_LOG_LEVEL`) sets
verbosity; the default is `info`.

A failure prints an `error:` line and a `hint:` line saying what to do about it,
and exits with a code the caller can branch on: `2` called wrong, `3` the
environment refused (retry), `4` bad data (fix the payload), `1` a bug in the
CLI.

Add a command by writing it in `cli/commands/` and listing it in
`cli/lib/registry.mts`.

## Contributing

See the [root README](/README.md#contributing) for branch and commit conventions.

## License

[MIT](/LICENSE) © Ian Remmel
