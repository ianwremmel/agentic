# Dispatch CLI framework

A tiny CLI framework for the `src/` rewrite. Commands are classes that declare
typed options; the framework parses argv into a typed value and hands it to the
command's `run`. Subcommands come from the folder tree under `src/commands/`,
not a hand-maintained registry. The command contract, discovery, and option
validation live in `lib/command/` so a future MCP server reuses them without
importing the cli namespace.

## Module layout

```
src/lib/command/          # shared by cli and (future) mcp
  abstract-command.mts    # AbstractCommand base class + Option/CommandContext types
  parse.mts               # raw values + positionals -> typed T (coerce, required, choices, default)
  discovery.mts           # scan a commands dir -> command tree
  index.mts               # barrel
src/lib/cli/
  cli.mts                 # runCli(): argv -> split, dispatch, help, error -> exit code
  index.mts               # barrel
src/lib/errors/
  dispatch-error.mts      # base: exit 1, hint, exitCode, toString
  usage-error.mts         # exit 2
  data-error.mts          # exit 4
  ensure.mts              # ensure() + assertUsage() helpers
  index.mts               # barrel
src/commands/             # real command files (leaf filename = command name)
src/main.mts              # discover(default dir) + runCli(process.argv)
```

`command.mts` moves out of `lib/cli/` (where it is now) into
`lib/command/abstract-command.mts`.

## Command contract

A command is a class extending `AbstractCommand`. Each command file exports its
subclass under the well-known name `Command`:

```ts
// src/commands/foo/bar.mts
import {AbstractCommand} from '../../lib/command/index.mts';

export class Command extends AbstractCommand {
  readonly name = 'bar';
  readonly summary = 'One line, shown in help.';
  readonly usage = 'dispatch foo bar [--force] --format <json|text>';
  readonly env = [];
  readonly options = {
    force:  {type: 'boolean', description: 'Skip the confirmation.'},
    count:  {type: 'number',  description: 'How many.', default: 1},
    format: {type: 'string',  description: 'Output shape.', choices: ['json', 'text'], required: true},
    path:   {type: 'string',  description: 'Target path.', positional: true},
  } as const;

  async run(parsed, ctx) {
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
  readonly positional?: boolean;      // consumes a positional arg instead of a --flag
  readonly required?: boolean;        // absent -> UsageError
  readonly default?: string | number | boolean;
  readonly choices?: readonly string[]; // string only; value outside the set -> UsageError
}
```

`options` is a `Record<string, Option>`. Authors write it `as const` so literal
`choices` tuples survive into the inferred type.

### Type inference

`run(parsed, ctx)` receives a value typed from `this.options`. The base declares

```ts
abstract run(parsed: ParsedOptions<this['options']>, ctx: CommandContext): Promise<void>;
```

and the subclass leaves `parsed` unannotated. TypeScript contextually types an
unannotated override parameter from the base signature, resolving `this['options']`
to the concrete `as const` literal, so `parsed` is inferred per command.

`ParsedOptions<O>` maps the options record to a value type:

- `boolean` -> `boolean`, always present (a bare flag defaults to `false`).
- `string` with `choices` -> the union of the choices; without -> `string`.
- `number` -> `number`.
- A key is a required property of the result when `required: true` or a `default`
  is present; otherwise it is optional (`T | undefined`).

**Inference is the one implementation risk.** Before building on it, a type-level
test (`ParsedOptions` applied to a sample options literal, asserted with an
`expectType`-style helper, plus a real subclass whose `run` body reads typed
fields) must compile. If TS cannot infer through `this['options']`, fall back to a
generic base `AbstractCommand<O extends OptionsRecord>` with the author annotating
`extends AbstractCommand<typeof …>`; the design records which one shipped.

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
  AbstractCommand` must hold — else `DataError` (exit 4) naming the file.
- Instantiate with `new Command()`.
- `instance.name` must equal the file basename (`bar.mts` -> `'bar'`) — else
  `DataError` naming the file, the declared name, and the expected name.

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
3. **Help mode** prints the deepest matched node's `usage` (or, for a
   namespace-only node, generated help listing its children) to `stdout` and
   returns 0.
4. **Namespace-only node with no runnable command** and a leftover unknown token
   -> `UsageError` (exit 2) listing the children.
5. **Runnable node.** Build a `node:util` `parseArgs` config from the command's
   `options` (booleans and strings native; `number` parsed as string). Map
   positionals to `positional` options in declared order. Pass raw values +
   positionals to `parse.mts`, which coerces numbers, enforces `required`,
   validates `choices`, and applies `default`s, throwing `UsageError` on any
   violation. Call `command.run(parsed, {log, env})`.
6. **Errors.** A thrown `DispatchError` prints its `toString()` to `stderr` and
   returns its `exitCode`. Any other throw prints a generic line and returns 1.

`node:util` `parseArgs` failures (unknown flag, missing option value) are caught
and rethrown as `UsageError` so they exit 2 instead of crashing.

## Errors

A trimmed taxonomy, one class per file, taking the agent-facing ideas from the
old `cli/` (a `hint` written for the agent that has to fix the failure, an
`exitCode` per class, lazy `ensure`) but only what this framework needs now:

- `DispatchError` — base. `message`, optional `hint`, `exitCode` (default 1),
  `toString()` that renders message + hint.
- `UsageError` — the CLI was called wrong (unknown flag, missing required, bad
  choice). Exit 2.
- `DataError` — bad authoring or discovery fault (name != filename, missing or
  invalid `Command` export). Exit 4.
- `ensure(cond, () => new SomeError(...))` and `assertUsage(cond, message)` —
  assertion helpers that construct the error only on failure.

`EnvironmentError`, `TaggedUsageError`, and the cause-chain rendering from the
old taxonomy are omitted until a real command needs them.

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
- missing required option -> exit 2; value outside `choices` -> exit 2.

Targeted tests where E2E cannot isolate the behavior:

- discovery throws `DataError` when `name` != filename;
- discovery throws `DataError` when the `Command` export is missing or is not an
  `AbstractCommand` subclass;
- a type-level test that `ParsedOptions` produces the expected value type and
  that a subclass's `run` sees inferred field types.

Each test targets one rule, so it fails only when that rule breaks.
