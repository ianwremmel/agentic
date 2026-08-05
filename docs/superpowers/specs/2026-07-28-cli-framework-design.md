# Dispatch CLI framework

A tiny CLI framework for the `src/` rewrite. Commands are classes that declare
typed options; the framework parses argv into a typed value and hands it to the
command's `run`. Subcommands come from the folder tree under `src/commands/`,
not a hand-maintained registry. The command contract, discovery, and option
validation live in `lib/command/` so a future MCP server reuses them without
importing the cli namespace.

## Transport neutrality

`AbstractCommand` describes *what a command is and does*, not how the CLI renders
it, so the same class backs an MCP tool later. The shared contract is `name`,
`summary`, `env`, `options`, and `run(parsed, ctx)`:

- `options` is a declarative schema. The cli turns it into argv parsing; MCP
  turns it into a tool input schema. Validation (`parse.mts`) takes a raw values
  object, never argv — the cli builds that object from argv, MCP from JSON tool
  input, and both feed the same validator.
- `run` receives the parsed value `T` and a `CommandContext` of `{log, env}` —
  nothing CLI-only (no streams, no argv).
- Thrown errors are transport-neutral: the cli maps `exitCode`; MCP maps the
  same classes to its own error shape.

CLI-only concerns stay in `lib/cli/`: `--help`, exit codes, and the **usage
string, which the cli generates from `name` + `options`** rather than the author
writing one. There is no `usage` field on the contract.

## Module layout

```text
src/lib/command/          # shared by cli and (future) mcp
  abstract-command.mts    # AbstractCommand base + Option/OptionsRecord/ParsedOptions/CommandContext types
  parse.mts               # raw values map -> validated values record (coerce, required, choices, default)
  env.mts                 # assertEnv(command.env, ctx.env) -> EnvironmentError if a key is missing
  discovery.mts           # scan a commands dir -> command tree
  index.mts               # barrel
src/lib/cli/
  cli.mts                 # runCli(): argv -> split, dispatch, help, generated usage, error -> exit code
  index.mts               # barrel
src/lib/errors/
  dispatch-error.mts      # base: exit 1, hint, exitCode, toString
  usage-error.mts         # exit 2
  environment-error.mts   # exit 3
  definition-error.mts    # a command is defined/registered wrong (exit 1)
  ensure.mts              # ensure() + assertUsage() helpers
  index.mts               # barrel
src/commands/             # real command files (leaf filename = command name)
src/main.mts              # discover(default dir) + runCli(process.argv)
```

`command.mts` moves out of `lib/cli/` (where it is now) into
`lib/command/abstract-command.mts`.

## Command contract

A command is a class extending `AbstractCommand`. Each command file declares its
`options` as a module-level `const` and exports its subclass under the
well-known name `Command`:

```ts
// src/commands/foo/bar.mts
import {AbstractCommand} from '../../lib/command/index.mts';
import type {ParsedOptions, CommandContext} from '../../lib/command/index.mts';

const options = {
  force:  {type: 'boolean', description: 'Skip the confirmation.', positional: false, required: false},
  count:  {type: 'number',  description: 'How many.', positional: false, required: false, default: 1},
  format: {type: 'string',  description: 'Output shape.', positional: false, required: true, choices: ['json', 'text']},
  path:   {type: 'string',  description: 'Target path.', positional: true, required: false},
} as const;

export class Command extends AbstractCommand {
  readonly name = 'bar';
  readonly summary = 'One line, shown in help.';
  readonly env = [];
  readonly options = options;

  async run(parsed: ParsedOptions<typeof options>, ctx: CommandContext): Promise<void> {
    // parsed: {force: boolean; count: number; format: 'json' | 'text'; path?: string}
    // ctx: {log, env}
  }
}
```

### Option

```ts
type OptionType = 'string' | 'number' | 'boolean';

interface Option {
  readonly type: OptionType;
  readonly description: string;
  readonly positional: boolean;       // consumes a positional arg instead of a --flag
  readonly required: boolean;         // absent at parse time -> UsageError
  readonly default?: string | number | boolean;
  readonly choices?: readonly string[]; // string only; value outside the set -> UsageError
}
```

`options` is a `Record<string, Option>`. Authors write it `as const` so literal
`choices` tuples survive into the inferred type.

### Type inference

The base class is **non-generic**. Its framework-facing `run` takes a wide,
already-validated value; the author overrides `run` with a signature typed from
their own `options` const via `ParsedOptions<typeof options>`:

```ts
abstract class AbstractCommand {
  abstract readonly name: string;
  abstract readonly summary: string;
  abstract readonly env: readonly string[];
  abstract readonly options: OptionsRecord;
  abstract run(parsed: Record<string, unknown>, ctx: CommandContext): Promise<void>;
}
```

Because `run` is a method, TypeScript's method-parameter bivariance lets the
author's narrower `run(parsed: ParsedOptions<typeof options>, …)` satisfy the
abstract `run(parsed: Record<string, unknown>, …)`. The framework only ever calls
the wide form (with the record `parse.mts` produces); the author's body sees the
precise type. Heterogeneous commands store in one `AbstractCommand[]` because the
wide `run` signature is identical across all of them.

`ParsedOptions<O>` maps the options record to a value type:

```ts
type OptionValue<O extends Option> =
  O extends {readonly type: 'boolean'} ? boolean
  : O extends {readonly type: 'number'} ? number
  : O extends {readonly choices: readonly (infer C extends string)[]} ? C
  : O extends {readonly type: 'string'} ? string
  : never;

type IsPresent<O extends Option> =
  O extends {readonly type: 'boolean'} ? true
  : O extends {readonly required: true} ? true
  : O extends {readonly default: string | number | boolean} ? true
  : false;

type PresentKeys<O extends OptionsRecord> = {
  [K in keyof O]: IsPresent<O[K]> extends true ? K : never;
}[keyof O];

type ParsedOptions<O extends OptionsRecord> = {
  [K in PresentKeys<O>]: OptionValue<O[K]>;
} & {[K in Exclude<keyof O, PresentKeys<O>>]?: OptionValue<O[K]>};
```

- `boolean` -> `boolean`, always present (a bare flag defaults to `false`).
- `string` with `choices` -> the union of the choices; without -> `string`.
- `number` -> `number`.
- A key is a required property when `required: true`, `default` is present, or
  the type is `boolean`; otherwise it is optional.

This whole arrangement was verified against the repo's `tsconfig.json` before the
plan was written: author-site types are real (a wrong `expectType` errors), `as
const` on `options` is required for `choices` to narrow, and no `override`
keyword is needed to implement the abstract members.

### CommandContext

```ts
interface CommandContext {
  readonly log: Logger;              // from lib/logger
  readonly env: NodeJS.ProcessEnv;
}
```

Commands emit through `log`. The cli's own chrome — help text, usage on error,
error lines — goes to `stdout`/`stderr` writables injected into `runCli`, not
through `CommandContext`. This keeps command output and framework output on
separate, independently-capturable channels for tests.

## Discovery

`discover(commandsDir: string | URL): Promise<CommandTree>` walks the directory,
dynamic-imports each `.mts`, and builds a tree keyed by path segment. The folder
path is the invocation path: `commands/foo/bar.mts` -> `foo bar`.

For every command file:

- The module must export `Command`, and `Command.prototype instanceof
  AbstractCommand` must hold — else `DefinitionError` naming the file.
- Instantiate with `new Command()`.
- `instance.name` must equal the file basename (`bar.mts` -> `'bar'`) — else
  `DefinitionError` naming the file, the declared name, and the expected name.

A directory is a parent node. `foo` can be **both** a runnable command (if
`commands/foo.mts` exists) and a namespace (from `commands/foo/`). A parent
directory with no sibling `foo.mts` is a namespace-only node with no `run`.

Discovery is async: `node:fs/promises` for the walk, dynamic `import()` per file.

## Parsing and dispatch (cli)

```ts
runCli(opts: {
  argv: string[];
  tree: CommandTree;
  log: Logger;
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
}): Promise<number>   // exit code
```

Steps:

1. **Help detection.** If `--help` or `-h` appears anywhere before a `--`
   terminator, it is help mode. Position is irrelevant.
2. **Walk the tree.** Consume leading tokens that match child names, descending
   to the deepest matching node. Parent/child precedence: when a token matches a
   child name, routing to the child wins over treating it as the parent's
   positional (git-style). Remaining tokens are the command's argv.
3. **Help mode** prints usage for the deepest matched node — a line generated
   from the command's `name` + `options`, or, for a namespace-only node,
   generated help listing its children — to `stdout` and returns 0.
4. **Namespace-only node with no runnable command** and a leftover unknown token
   -> `UsageError` (exit 2) listing the children.
5. **Runnable node.** Build a `node:util` `parseArgs` config from the command's
   `options` (booleans and strings native; `number` parsed as string). Map
   positionals to `positional` options in declared order. Pass raw values +
   positionals to `parse.mts`, which coerces numbers, enforces `required`,
   validates `choices`, and applies `default`s, throwing `UsageError` on any
   violation. Then `assertEnv(command.env, env)` throws `EnvironmentError`
   (exit 3) if any declared env key is missing. Call `command.run(parsed,
   {log, env})`.
6. **Errors.** A thrown `DispatchError` prints its `toString()` to `stderr` and
   returns its `exitCode`. Any other throw prints a generic line and returns 1.

The env check and option validation both live in `lib/command/`, so the MCP
server runs the identical guards before invoking a command.

`node:util` `parseArgs` failures (unknown flag, missing option value) are caught
and rethrown as `UsageError` so they exit 2 instead of crashing.

## Errors

A trimmed taxonomy, one class per file, taking the agent-facing ideas from the
old `cli/` (a `hint` written for the agent that has to fix the failure, an
`exitCode` per class, lazy `ensure`) but only what this framework needs now:

- `DispatchError` — base. `message`, optional `hint`, `exitCode` (default 1),
  `toString()` that renders message + hint.
- `UsageError` — the caller invoked the command wrong (unknown flag, missing
  required, value outside `choices`). Exit 2.
- `EnvironmentError` — a variable declared in the command's `env` is missing from
  the environment. The command was right; the environment was not. Exit 3.
- `DefinitionError` — a command is defined or registered wrong (name != filename,
  missing or non-`AbstractCommand` `Command` export). This is a bug in the
  plugin, fixed by editing the command file, so it carries the base exit code 1
  and a hint naming the file and the fix.
- `ensure(cond, () => new SomeError(...))` and `assertUsage(cond, message)` —
  assertion helpers that construct the error only on failure.

`TaggedUsageError` and the cause-chain rendering from the old taxonomy are
omitted until a real command needs them.

## Testing

Mostly end-to-end, against a hermetic fixtures tree at
`src/lib/command/__fixtures__/commands/` holding a few example commands. Each
E2E test calls `runCli` with an argv, a recording logger sink, and
string-capturing `stdout`/`stderr`, then asserts the exit code and the captured
output.

E2E coverage:

- leaf command dispatch and typed parsing (boolean flag, number coercion,
  string, positional, default applied);
- subcommand dispatch (`foo bar`);
- parent that is both runnable and a namespace — child name wins; a
  non-child token routes to the parent's `run`;
- namespace-only node prints help; unknown token under it -> exit 2;
- `--help` in every position resolves to the deepest command path;
- unknown flag / unknown command -> exit 2;
- missing required option -> exit 2; value outside `choices` -> exit 2;
- a command declaring `env` runs when the key is present and exits 3 when it is
  missing.

Targeted tests where E2E cannot isolate the behavior:

- discovery throws `DefinitionError` when `name` != filename;
- discovery throws `DefinitionError` when the `Command` export is missing or is
  not an `AbstractCommand` subclass;
- a type-level test that `ParsedOptions` produces the expected value type and
  that a subclass's `run` sees inferred field types.

Each test targets one rule, so it fails only when that rule breaks.
