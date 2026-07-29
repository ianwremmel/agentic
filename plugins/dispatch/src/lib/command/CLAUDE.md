# Command

The transport-neutral command contract, plus the validation and discovery built
on it. Nothing here depends on the CLI: `lib/cli` consumes it, and a future MCP
server will too. `index.mts` is the barrel.

## The contract (`abstract-command.mts`)

`AbstractCommand` is a non-generic base. The framework only ever calls the wide
`run(parsed: Record<string, unknown>, ctx: CommandContext)`. A command author
subclasses it, declares `options` as a module-level `const … as const`, and
overrides `run` with a signature typed from those options:
`run(parsed: ParsedOptions<typeof options>, ctx)`. Method-parameter bivariance
makes that a valid override, so the author's body sees precise types while
heterogeneous commands still store in one `AbstractCommand[]`.

`Option` fields: `type`, `description`, `positional` and `required` (both
mandatory), optional `default` and `choices`. `choices` applies to string
options only; `default` is ignored for booleans (an absent flag is always
`false`). Author options `as const` — the literal `choices` tuple is what lets
`ParsedOptions` narrow a field to its union.

`ParsedOptions<O>` maps the options record to the parsed value type: a key is
required when `required: true`, a `default` is present, or the type is
`boolean`; otherwise it is optional.

## Validation and discovery

- `parseOptions(options, raw)` turns a raw values map (keyed by option name) into
  a validated record: coerces numbers (decimal literals only — `Infinity`, hex,
  and whitespace are rejected), enforces `required`, validates `choices`, applies
  `default`s. Bad input throws `UsageError`. The cli builds `raw` from argv; an
  MCP server would build it from JSON — same validator.
- `assertEnv(required, env)` throws `EnvironmentError` naming every variable a
  command declared in `env` that the environment lacks.
- `discover(dir)` walks a commands directory into a `CommandNode` tree keyed by
  folder segment (folder path = invocation path). It skips `*.test.mts`, and
  throws `DefinitionError` when a module lacks a `Command` export extending
  `AbstractCommand`, or when the command's `name` ≠ its file basename.

Keep the contract free of CLI-only concerns (argv, streams, usage strings) so it
stays reusable.
