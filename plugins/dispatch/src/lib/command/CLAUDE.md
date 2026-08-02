# Command

The transport-neutral command contract plus the validation and discovery built on
it. Nothing here depends on the CLI — `lib/cli` consumes it, and a future MCP
server will too. `index.mts` is the barrel.

- `abstract-command.mts` — `AbstractCommand`, the `Option` shape, and the
  `ParsedOptions<typeof options>` type a command uses to type its `run`; also
  defines `Io` (the command's response channel, distinct from `log`) and the
  concrete `transports` field, both on `CommandContext`. The docblocks cover
  the bivariance override and how presence/`choices` narrow the parsed type.
- `transports.mts` — `resolveTransports(command)` fills the `transports` partial
  with `{cli: true, mcp: true}` defaults so gating reads definite booleans.
- `parse.mts` — `parseOptions` turns a raw values map into a validated record
  (coerce numbers, enforce `required`, check `choices`, apply defaults). The cli
  builds `raw` from argv; an MCP server would from JSON.
- `env.mts` — `assertEnv` throws for any variable a command declared in `env`
  that the environment lacks.
- `discovery.mts` — `discover` walks a commands dir into a `CommandNode` tree
  (folder path = invocation path).
- `test-support.mts` — `runCommand` (runs a command as a transport would and
  returns its `io` output) plus the fixtures every command test needs:
  `tempEnv()` for a throwaway graph database and `ticket()` for a blank ticket.

Keep CLI-only concerns (argv, streams, usage strings) out so the contract stays
reusable.
