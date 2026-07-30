# CLI

`runCli({argv, tree, log, env, stdout, stderr})` in `cli.mts` drives a discovered
command tree and returns an exit code. This is the only layer that knows about
argv, `--help`, exit codes, and usage text — the `lib/command` contract stays
transport-neutral. `index.mts` is the barrel.

Read `cli.mts` for the walk / help / parse / error-mapping details. Usage text is
generated from a command's `name` + `options`, so commands never author one.

`runCli` also supplies each command an `io` bound to `stdout` (its response
channel, separate from `log`) and hides/refuses any command whose `cli`
transport is off (`resolveTransports`).
