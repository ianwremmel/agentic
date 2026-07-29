# Commands

Each file here is one command, discovered automatically — there is no registry.
The folder path is the invocation path: `foo/bar.mts` becomes `dispatch foo bar`.
A directory can be both a namespace and a runnable command (a sibling `foo.mts`
alongside a `foo/` directory).

Authoring a command:

- Export a class named `Command` that extends `AbstractCommand` (from
  `../lib/command/index.mts`). The class's `name` must equal the file's basename
  (`bar.mts` → `name = 'bar'`), or discovery throws a `DefinitionError`.
- Declare `options` as a module-level `const … as const` and type `run`'s first
  parameter `ParsedOptions<typeof options>` — see `../lib/command/CLAUDE.md` for
  the option fields and how the type is inferred.
- `run` is `async` and returns `Promise<void>`. Emit output through `ctx.log`;
  read configuration from `ctx.env`. List every environment variable the command
  needs in `env` — the runner checks them before calling `run`.

`greet.mts` is the worked example. Skill-invoked commands must resolve inside the
plugin directory, so keep everything a command needs under `plugins/dispatch`.
