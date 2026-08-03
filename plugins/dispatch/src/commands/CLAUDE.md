# Commands

One file per command, discovered automatically — no registry. The folder path is
the invocation path: `foo/bar.mts` → `dispatch foo bar`, and a `foo.mts` beside a
`foo/` directory makes that node both runnable and a namespace.

A command subclasses `AbstractCommand` (`../lib/command`); that contract — the
`Command` export, the `name` matching the file basename, `options`, `env`, `run` —
lives there and is enforced by `discover`. `greet.mts` is the worked example.

Skill-invoked commands must resolve inside the plugin directory, so keep
everything a command needs under `plugins/dispatch`.
