# CLI

`runCli({argv, tree, log, env, stdout, stderr})` drives a discovered command
tree from argv and returns an exit code. This is the only layer that knows about
argv, `--help`, exit codes, and usage text; the command contract in `lib/command`
stays transport-neutral. `index.mts` is the barrel.

What it does:

- Walks `argv` down the tree to the deepest matching command. A token that
  matches a child name routes to the child (subcommand wins over treating it as
  the parent's positional).
- `--help`/`-h` anywhere before a `--` terminator is help mode: it prints usage
  for the deepest matched node and returns 0. Position is irrelevant.
- Builds a `node:util` `parseArgs` config from the command's `options`, maps
  positionals in declared order, then hands the values to `parseOptions`. A
  `parseArgs` failure is re-tagged as a `UsageError` rather than crashing.
- Runs `assertEnv` before invoking the command.
- Maps a thrown `DispatchError` to its `exitCode` (printing `toString()` to
  stderr); any other throw is a bug and exits 1.

Usage text is generated from a command's `name` + `options` — commands do not
author a `usage` string.
