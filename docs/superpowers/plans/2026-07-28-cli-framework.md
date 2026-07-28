# Dispatch CLI framework implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tiny CLI framework where commands are classes that declare typed options, argv is parsed into a validated value before `run`, and subcommands are discovered from the folder tree under `src/commands/`.

**Architecture:** Three layers. `lib/errors/` is a small agent-facing error taxonomy. `lib/command/` holds the transport-neutral contract (`AbstractCommand`, option types, `ParsedOptions`), option validation (`parse.mts`), the env guard (`env.mts`), and folder-tree discovery (`discovery.mts`) — all reusable by a future MCP server. `lib/cli/` holds `runCli`, which walks argv against the tree, generates usage/help, validates, and maps thrown `DispatchError`s to exit codes.

**Tech Stack:** TypeScript `.mts` run unbuilt on Node ≥24.18 native type stripping; `node:util` `parseArgs`, `node:fs/promises`, `node:test`. No runtime dependencies.

## Global Constraints

- Node `>=24.18.0`; all source is `.mts`, imported by real path with extension (`./abstract-command.mts`).
- tsconfig is strict with: `erasableSyntaxOnly` (no enums, namespaces, or parameter properties), `verbatimModuleSyntax` (use `import type` for type-only imports), `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`.
- Every folder under `lib/` gets a barrel `index.mts`.
- Tests are colocated and named `*.test.mts` (the test runner glob is `plugins/**/*.test.mts`).
- One class per error file.
- Errors are read by an agent: a `DispatchError` carries a `hint` naming the field and the fix.
- Before starting: run `npm install` (installs the git hooks). Before finishing each task: `npm run lint`, `npm run typecheck`, `npm test`.
- Conventional commit messages; no `Co-Authored-By`/`Generated with` trailers.

---

## Task 1: Error taxonomy

**Files:**
- Create: `plugins/dispatch/src/lib/errors/dispatch-error.mts`
- Create: `plugins/dispatch/src/lib/errors/usage-error.mts`
- Create: `plugins/dispatch/src/lib/errors/environment-error.mts`
- Create: `plugins/dispatch/src/lib/errors/definition-error.mts`
- Create: `plugins/dispatch/src/lib/errors/ensure.mts`
- Create: `plugins/dispatch/src/lib/errors/index.mts`
- Test: `plugins/dispatch/src/lib/errors/errors.test.mts`

**Interfaces:**
- Produces: `class DispatchError extends Error` with `readonly exitCode: number` (default 1), `readonly hint: string | undefined`, `toString()`; constructor `(message: string, options?: {hint?: string; cause?: unknown})`. `class UsageError extends DispatchError` (exitCode 2). `class EnvironmentError extends DispatchError` (exitCode 3). `class DefinitionError extends DispatchError` (exitCode 1, distinct name). `function assertUsage(condition: unknown, message: string): asserts condition`. `function ensure(condition: unknown, error: () => DispatchError): asserts condition`.

- [ ] **Step 1: Write the failing test**

`plugins/dispatch/src/lib/errors/errors.test.mts`:

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  DispatchError,
  UsageError,
  EnvironmentError,
  DefinitionError,
  assertUsage,
  ensure,
} from './index.mts';

describe('error taxonomy', () => {
  it('DispatchError defaults to exit 1 and renders its message', () => {
    const error = new DispatchError('boom');
    assert.equal(error.exitCode, 1);
    assert.match(error.toString(), /boom/);
  });

  it('renders a hint on its own line', () => {
    const error = new DispatchError('boom', {hint: 'do the thing'});
    assert.match(error.toString(), /hint: do the thing/);
  });

  it('assigns an exit code per subclass', () => {
    assert.equal(new UsageError('x').exitCode, 2);
    assert.equal(new EnvironmentError('x').exitCode, 3);
    assert.equal(new DefinitionError('x').exitCode, 1);
  });

  it('subclasses are DispatchError instances with their own name', () => {
    const usage = new UsageError('x');
    assert.ok(usage instanceof DispatchError);
    assert.equal(usage.name, 'UsageError');
  });

  it('assertUsage throws a UsageError when the condition is falsy', () => {
    assert.throws(() => {
      assertUsage(false, 'bad flag');
    }, UsageError);
    assert.doesNotThrow(() => {
      assertUsage(true, 'unused');
    });
  });

  it('ensure builds the error lazily, only on failure', () => {
    let built = 0;
    ensure(true, () => {
      built += 1;
      return new DispatchError('unused');
    });
    assert.equal(built, 0);
    assert.throws(() => {
      ensure(false, () => new DefinitionError('nope'));
    }, DefinitionError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `./index.mts` / the error classes are not defined.

- [ ] **Step 3: Write the implementations**

`dispatch-error.mts`:

```ts
export interface DispatchErrorOptions extends ErrorOptions {
  /** What to do about it, written for the agent that ran the command. */
  readonly hint?: string;
}

/** A failure the caller can act on, as opposed to a crash. */
export class DispatchError extends Error {
  override readonly name: string = 'DispatchError';
  readonly exitCode: number = 1;
  readonly hint: string | undefined;

  constructor(message: string, options: DispatchErrorOptions = {}) {
    super(message, options);
    this.hint = options.hint;
  }

  override toString(): string {
    return this.hint === undefined
      ? `${this.name}: ${this.message}`
      : `${this.name}: ${this.message}\nhint: ${this.hint}`;
  }
}
```

`usage-error.mts`:

```ts
import {DispatchError} from './dispatch-error.mts';

/** The caller invoked the command wrong: an unknown flag, a missing argument, a bad choice. */
export class UsageError extends DispatchError {
  override readonly name: string = 'UsageError';
  override readonly exitCode = 2;
}
```

`environment-error.mts`:

```ts
import {DispatchError} from './dispatch-error.mts';

/** A variable the command declared in `env` is missing. The command was right; the environment was not. */
export class EnvironmentError extends DispatchError {
  override readonly name: string = 'EnvironmentError';
  override readonly exitCode = 3;
}
```

`definition-error.mts`:

```ts
import {DispatchError} from './dispatch-error.mts';

/** A command is defined or registered wrong — a bug in the plugin, fixed by editing the command file. */
export class DefinitionError extends DispatchError {
  override readonly name: string = 'DefinitionError';
}
```

`ensure.mts`:

```ts
import type {DispatchError} from './dispatch-error.mts';
import {UsageError} from './usage-error.mts';

/** `assert` for caller input: a failed check is a usage error, not a crash. */
export function assertUsage(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new UsageError(message);
  }
}

/** `assert` against a taxonomy error, built lazily so the passing path never constructs it. */
export function ensure(
  condition: unknown,
  error: () => DispatchError
): asserts condition {
  if (!condition) {
    throw error();
  }
}
```

`index.mts`:

```ts
export * from './dispatch-error.mts';
export * from './usage-error.mts';
export * from './environment-error.mts';
export * from './definition-error.mts';
export * from './ensure.mts';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test` then `npm run typecheck` and `npm run lint`
Expected: PASS on all three.

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/errors
git commit -m "feat: add dispatch error taxonomy"
```

---

## Task 2: Command contract and type inference

**Files:**
- Create: `plugins/dispatch/src/lib/command/abstract-command.mts`
- Create: `plugins/dispatch/src/lib/command/abstract-command.types.mts` (typecheck-only assertions; not a runtime test)
- Create: `plugins/dispatch/src/lib/command/index.mts` (barrel; grows in later tasks)

**Interfaces:**
- Consumes: `Logger` from `../logger/index.mts`.
- Produces: `type OptionType = 'string' | 'number' | 'boolean'`. `interface Option {type; description; positional; required; default?; choices?}`. `type OptionsRecord = Readonly<Record<string, Option>>`. `type OptionValue<O>`, `type IsPresent<O>`, `type PresentKeys<O>`, `type ParsedOptions<O extends OptionsRecord>`. `interface CommandContext {log: Logger; env: NodeJS.ProcessEnv}`. `abstract class AbstractCommand` with abstract `name`, `summary`, `env: readonly string[]`, `options: OptionsRecord`, and `run(parsed: Record<string, unknown>, ctx: CommandContext): Promise<void>`.

- [ ] **Step 1: Write the type-level assertion file**

This file has no runtime assertions; it must **typecheck**. If it compiles, inference works; a wrong `expectType` line would fail `tsc`. `abstract-command.types.mts`:

```ts
import {AbstractCommand} from './abstract-command.mts';
import type {ParsedOptions, CommandContext} from './abstract-command.mts';

function expectType<T>(_value: T): void {
  // asserts the argument's static type is assignable to T
}

const options = {
  force: {type: 'boolean', description: 'd', positional: false, required: false},
  count: {type: 'number', description: 'd', positional: false, required: false, default: 1},
  format: {type: 'string', description: 'd', positional: false, required: true, choices: ['json', 'text']},
  who: {type: 'string', description: 'd', positional: true, required: false},
} as const;

class Sample extends AbstractCommand {
  readonly name = 'sample';
  readonly summary = 's';
  readonly env = [];
  readonly options = options;

  async run(parsed: ParsedOptions<typeof options>, _ctx: CommandContext): Promise<void> {
    expectType<boolean>(parsed.force);
    expectType<number>(parsed.count);
    expectType<'json' | 'text'>(parsed.format);
    expectType<string | undefined>(parsed.who);
  }
}

// Reference the class so it is not treated as unused.
void Sample;

// Heterogeneous storage must compile: a subclass widens to AbstractCommand.
const registry: AbstractCommand[] = [new Sample()];
void registry;
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npm run typecheck`
Expected: FAIL — `abstract-command.mts` does not exist / exports are missing.

- [ ] **Step 3: Write the contract**

`abstract-command.mts`:

```ts
import type {Logger} from '../logger/index.mts';

export type OptionType = 'string' | 'number' | 'boolean';

export interface Option {
  readonly type: OptionType;
  readonly description: string;
  /** Consumes a positional argument instead of a `--flag`. */
  readonly positional: boolean;
  /** Absent at parse time is a usage error. */
  readonly required: boolean;
  readonly default?: string | number | boolean;
  /** String options only; a value outside the set is a usage error. */
  readonly choices?: readonly string[];
}

export type OptionsRecord = Readonly<Record<string, Option>>;

export type OptionValue<O extends Option> =
  O extends {readonly type: 'boolean'} ? boolean
  : O extends {readonly type: 'number'} ? number
  : O extends {readonly choices: readonly (infer C extends string)[]} ? C
  : O extends {readonly type: 'string'} ? string
  : never;

export type IsPresent<O extends Option> =
  O extends {readonly type: 'boolean'} ? true
  : O extends {readonly required: true} ? true
  : O extends {readonly default: string | number | boolean} ? true
  : false;

export type PresentKeys<O extends OptionsRecord> = {
  [K in keyof O]: IsPresent<O[K]> extends true ? K : never;
}[keyof O];

/** The value a command's `run` receives: present keys required, the rest optional. */
export type ParsedOptions<O extends OptionsRecord> = {
  [K in PresentKeys<O>]: OptionValue<O[K]>;
} & {
  [K in Exclude<keyof O, PresentKeys<O>>]?: OptionValue<O[K]>;
};

/**
 * What a command is handed at run time. The logger is injected so commands stay
 * callable outside a process; `env` is the source for `assertEnv`.
 */
export interface CommandContext {
  readonly log: Logger;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The transport-neutral command contract. The framework-facing `run` takes an
 * already-validated values record; a subclass overrides it with a signature
 * typed from its own options const (`ParsedOptions<typeof options>`), which
 * method-parameter bivariance accepts.
 */
export abstract class AbstractCommand {
  abstract readonly name: string;
  abstract readonly summary: string;
  abstract readonly env: readonly string[];
  abstract readonly options: OptionsRecord;
  abstract run(parsed: Record<string, unknown>, ctx: CommandContext): Promise<void>;
}
```

`index.mts` (barrel — later tasks append to it):

```ts
export * from './abstract-command.mts';
```

- [ ] **Step 4: Run typecheck to verify it passes**

Run: `npm run typecheck`
Expected: PASS. (Sanity-check the inference is real: temporarily change one `expectType` line in the types file to a wrong type, e.g. `expectType<number>(parsed.format)`, confirm `tsc` errors, then revert.)

Also run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/command/abstract-command.mts plugins/dispatch/src/lib/command/abstract-command.types.mts plugins/dispatch/src/lib/command/index.mts
git commit -m "feat: add command contract with typed option inference"
```

---

## Task 3: Option validation (parse.mts)

**Files:**
- Create: `plugins/dispatch/src/lib/command/parse.mts`
- Modify: `plugins/dispatch/src/lib/command/index.mts` (add `export * from './parse.mts';`)
- Test: `plugins/dispatch/src/lib/command/parse.test.mts`

**Interfaces:**
- Consumes: `OptionsRecord` from `./abstract-command.mts`; `assertUsage` from `../errors/index.mts`.
- Produces: `function parseOptions(options: OptionsRecord, raw: Readonly<Record<string, string | boolean>>): Record<string, unknown>` — coerces numbers, enforces `required`, validates `choices`, applies `default`s, defaults booleans to `false`.

- [ ] **Step 1: Write the failing test**

`parse.test.mts`:

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parseOptions} from './parse.mts';
import type {OptionsRecord} from './abstract-command.mts';
import {UsageError} from '../errors/index.mts';

const options: OptionsRecord = {
  loud: {type: 'boolean', description: 'd', positional: false, required: false},
  count: {type: 'number', description: 'd', positional: false, required: false, default: 3},
  name: {type: 'string', description: 'd', positional: false, required: true},
  format: {type: 'string', description: 'd', positional: false, required: false, choices: ['json', 'text']},
};

describe('parseOptions', () => {
  it('defaults a missing boolean to false and applies numeric defaults', () => {
    const parsed = parseOptions(options, {name: 'ada'});
    assert.equal(parsed.loud, false);
    assert.equal(parsed.count, 3);
    assert.equal(parsed.name, 'ada');
  });

  it('coerces a numeric string to a number', () => {
    const parsed = parseOptions(options, {name: 'ada', count: '10'});
    assert.equal(parsed.count, 10);
  });

  it('rejects a non-numeric value for a number option', () => {
    assert.throws(() => parseOptions(options, {name: 'ada', count: 'abc'}), UsageError);
    assert.throws(() => parseOptions(options, {name: 'ada', count: ''}), UsageError);
  });

  it('rejects a missing required option', () => {
    assert.throws(() => parseOptions(options, {}), UsageError);
  });

  it('rejects a value outside choices and accepts one inside', () => {
    assert.throws(() => parseOptions(options, {name: 'ada', format: 'xml'}), UsageError);
    const parsed = parseOptions(options, {name: 'ada', format: 'json'});
    assert.equal(parsed.format, 'json');
  });

  it('omits an absent optional non-boolean option', () => {
    const parsed = parseOptions(options, {name: 'ada'});
    assert.equal('format' in parsed, false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `parseOptions` is not defined.

- [ ] **Step 3: Write the implementation**

`parse.mts`:

```ts
import type {OptionsRecord} from './abstract-command.mts';
import {assertUsage} from '../errors/index.mts';

/**
 * Turn a raw values map (keyed by option name) into a validated values record.
 * Transport-neutral: the cli builds `raw` from argv, an MCP server from JSON.
 */
export function parseOptions(
  options: OptionsRecord,
  raw: Readonly<Record<string, string | boolean>>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, option] of Object.entries(options)) {
    const provided = raw[key];

    if (provided === undefined) {
      if (option.type === 'boolean') {
        result[key] = false;
      } else if (option.default !== undefined) {
        result[key] = option.default;
      } else {
        assertUsage(!option.required, `missing required option: ${key}`);
      }
      continue;
    }

    if (option.type === 'boolean') {
      result[key] = provided === true || provided === 'true';
      continue;
    }

    const text = String(provided);
    if (option.type === 'number') {
      const value = Number(text);
      assertUsage(
        text.trim() !== '' && !Number.isNaN(value),
        `option ${key} expects a number, got "${text}"`
      );
      result[key] = value;
      continue;
    }

    if (option.choices !== undefined) {
      assertUsage(
        option.choices.includes(text),
        `option ${key} must be one of: ${option.choices.join(', ')}`
      );
    }
    result[key] = text;
  }

  return result;
}
```

Append to `index.mts`: `export * from './parse.mts';`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test` then `npm run typecheck` and `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/command/parse.mts plugins/dispatch/src/lib/command/parse.test.mts plugins/dispatch/src/lib/command/index.mts
git commit -m "feat: add option validation and coercion"
```

---

## Task 4: Environment guard (env.mts)

**Files:**
- Create: `plugins/dispatch/src/lib/command/env.mts`
- Modify: `plugins/dispatch/src/lib/command/index.mts` (add `export * from './env.mts';`)
- Test: `plugins/dispatch/src/lib/command/env.test.mts`

**Interfaces:**
- Consumes: `EnvironmentError`, `ensure` from `../errors/index.mts`.
- Produces: `function assertEnv(required: readonly string[], env: NodeJS.ProcessEnv): void` — throws `EnvironmentError` naming every missing key.

- [ ] **Step 1: Write the failing test**

`env.test.mts`:

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {assertEnv} from './env.mts';
import {EnvironmentError} from '../errors/index.mts';

describe('assertEnv', () => {
  it('passes when every declared key is present', () => {
    assert.doesNotThrow(() => assertEnv(['TOKEN'], {TOKEN: 'x'}));
  });

  it('passes when nothing is declared', () => {
    assert.doesNotThrow(() => assertEnv([], {}));
  });

  it('throws EnvironmentError naming the missing keys', () => {
    assert.throws(
      () => assertEnv(['TOKEN', 'REGION'], {TOKEN: 'x'}),
      (error: unknown) => error instanceof EnvironmentError && /REGION/.test(error.message)
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `assertEnv` is not defined.

- [ ] **Step 3: Write the implementation**

`env.mts`:

```ts
import {EnvironmentError, ensure} from '../errors/index.mts';

/** Throw if any variable a command declared in `env` is absent from the environment. */
export function assertEnv(
  required: readonly string[],
  env: NodeJS.ProcessEnv
): void {
  const missing = required.filter((key) => env[key] === undefined);
  ensure(
    missing.length === 0,
    () =>
      new EnvironmentError(`missing required environment: ${missing.join(', ')}`, {
        hint: `set ${missing.join(', ')} before running this command`,
      })
  );
}
```

Append to `index.mts`: `export * from './env.mts';`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test` then `npm run typecheck` and `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/command/env.mts plugins/dispatch/src/lib/command/env.test.mts plugins/dispatch/src/lib/command/index.mts
git commit -m "feat: add declared-environment guard"
```

---

## Task 5: Folder-tree discovery

**Files:**
- Create: `plugins/dispatch/src/lib/command/discovery.mts`
- Modify: `plugins/dispatch/src/lib/command/index.mts` (add `export * from './discovery.mts';`)
- Create fixtures (good tree): `plugins/dispatch/src/lib/command/__fixtures__/commands/greet.mts`, `.../commands/math/add.mts`, `.../commands/needs-token.mts`, `.../commands/store.mts`, `.../commands/store/get.mts`
- Create fixtures (bad): `plugins/dispatch/src/lib/command/__fixtures__/bad-name/mismatch.mts`, `.../bad-export/oops.mts`
- Test: `plugins/dispatch/src/lib/command/discovery.test.mts`

**Interfaces:**
- Consumes: `AbstractCommand` from `./abstract-command.mts`; `DefinitionError`, `ensure` from `../errors/index.mts`.
- Produces: `interface CommandNode {readonly name: string; command: AbstractCommand | undefined; readonly children: Map<string, CommandNode>}`. `function discover(commandsDir: string | URL): Promise<CommandNode>` — returns the root node whose `children` are the top-level commands.

- [ ] **Step 1: Write the fixtures**

Each fixture is a real command. Note the import depth: files directly under `__fixtures__/commands/` reach the barrel via `../../index.mts`; files one directory deeper (`math/`, `store/`) via `../../../index.mts`; files under `__fixtures__/bad-*/` via `../../index.mts`.

`__fixtures__/commands/greet.mts`:

```ts
import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {
  who: {type: 'string', description: 'Who to greet.', positional: true, required: false, default: 'world'},
  format: {type: 'string', description: 'Output shape.', positional: false, required: false, default: 'text', choices: ['text', 'json']},
} as const;

export class Command extends AbstractCommand {
  readonly name = 'greet';
  readonly summary = 'Print a greeting.';
  readonly env = [];
  readonly options = options;

  async run(parsed: ParsedOptions<typeof options>, ctx: CommandContext): Promise<void> {
    if (parsed.format === 'json') {
      ctx.log.info(JSON.stringify({hello: parsed.who}));
    } else {
      ctx.log.info(`hello ${parsed.who}`);
    }
  }
}
```

`__fixtures__/commands/math/add.mts`:

```ts
import {AbstractCommand} from '../../../index.mts';
import type {ParsedOptions, CommandContext} from '../../../index.mts';

const options = {
  a: {type: 'number', description: 'First addend.', positional: false, required: true},
  b: {type: 'number', description: 'Second addend.', positional: false, required: true},
} as const;

export class Command extends AbstractCommand {
  readonly name = 'add';
  readonly summary = 'Add two numbers.';
  readonly env = [];
  readonly options = options;

  async run(parsed: ParsedOptions<typeof options>, ctx: CommandContext): Promise<void> {
    ctx.log.info(String(parsed.a + parsed.b));
  }
}
```

`__fixtures__/commands/needs-token.mts`:

```ts
import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {} as const;

export class Command extends AbstractCommand {
  readonly name = 'needs-token';
  readonly summary = 'Requires MY_TOKEN.';
  readonly env = ['MY_TOKEN'];
  readonly options = options;

  async run(_parsed: ParsedOptions<typeof options>, ctx: CommandContext): Promise<void> {
    ctx.log.info('ok');
  }
}
```

`__fixtures__/commands/store.mts` (a parent that is also runnable):

```ts
import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {
  key: {type: 'string', description: 'Key to read.', positional: true, required: false},
} as const;

export class Command extends AbstractCommand {
  readonly name = 'store';
  readonly summary = 'Inspect the store.';
  readonly env = [];
  readonly options = options;

  async run(parsed: ParsedOptions<typeof options>, ctx: CommandContext): Promise<void> {
    ctx.log.info(`store ${parsed.key ?? '(root)'}`);
  }
}
```

`__fixtures__/commands/store/get.mts`:

```ts
import {AbstractCommand} from '../../../index.mts';
import type {ParsedOptions, CommandContext} from '../../../index.mts';

const options = {
  key: {type: 'string', description: 'Key to read.', positional: true, required: true},
} as const;

export class Command extends AbstractCommand {
  readonly name = 'get';
  readonly summary = 'Read one key.';
  readonly env = [];
  readonly options = options;

  async run(parsed: ParsedOptions<typeof options>, ctx: CommandContext): Promise<void> {
    ctx.log.info(`get ${parsed.key}`);
  }
}
```

`__fixtures__/bad-name/mismatch.mts` (declares a name that does not match the file):

```ts
import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {} as const;

export class Command extends AbstractCommand {
  readonly name = 'wrong';
  readonly summary = 'Name does not match the file.';
  readonly env = [];
  readonly options = options;

  async run(_parsed: ParsedOptions<typeof options>, _ctx: CommandContext): Promise<void> {}
}
```

`__fixtures__/bad-export/oops.mts` (no `Command` export):

```ts
export const notACommand = 42;
```

- [ ] **Step 2: Write the failing test**

`discovery.test.mts`:

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {discover} from './discovery.mts';
import {DefinitionError} from '../errors/index.mts';

const GOOD = new URL('./__fixtures__/commands/', import.meta.url);
const BAD_NAME = new URL('./__fixtures__/bad-name/', import.meta.url);
const BAD_EXPORT = new URL('./__fixtures__/bad-export/', import.meta.url);

describe('discover', () => {
  it('builds a tree keyed by folder path', async () => {
    const root = await discover(GOOD);
    assert.equal(root.children.get('greet')?.command?.name, 'greet');
    assert.equal(root.children.get('math')?.children.get('add')?.command?.name, 'add');
    // `math` is a namespace-only node: no math.mts, so no command of its own.
    assert.equal(root.children.get('math')?.command, undefined);
  });

  it('lets a folder be both a runnable command and a namespace', async () => {
    const root = await discover(GOOD);
    const store = root.children.get('store');
    assert.equal(store?.command?.name, 'store');
    assert.equal(store?.children.get('get')?.command?.name, 'get');
  });

  it('throws DefinitionError when a command name does not match its file', async () => {
    await assert.rejects(discover(BAD_NAME), DefinitionError);
  });

  it('throws DefinitionError when a file has no Command export', async () => {
    await assert.rejects(discover(BAD_EXPORT), DefinitionError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `discover` is not defined.

- [ ] **Step 4: Write the implementation**

`discovery.mts`:

```ts
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {AbstractCommand} from './abstract-command.mts';
import {DefinitionError, ensure} from '../errors/index.mts';

export interface CommandNode {
  readonly name: string;
  command: AbstractCommand | undefined;
  readonly children: Map<string, CommandNode>;
}

function makeNode(name: string): CommandNode {
  return {name, command: undefined, children: new Map()};
}

/** Walk `commandsDir`, load each `.mts` command, and assemble the invocation tree. */
export async function discover(commandsDir: string | URL): Promise<CommandNode> {
  const dir =
    typeof commandsDir === 'string' ? commandsDir : fileURLToPath(commandsDir);
  const root = makeNode('');

  const entries = await readdir(dir, {recursive: true, withFileTypes: true});
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.mts') &&
        !entry.name.endsWith('.test.mts')
    )
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();

  for (const relative of files) {
    const segments = relative.slice(0, -'.mts'.length).split(path.sep);
    const command = await loadCommand(dir, relative, segments);
    insert(root, segments, command);
  }

  return root;
}

async function loadCommand(
  dir: string,
  relative: string,
  segments: string[]
): Promise<AbstractCommand> {
  const href = pathToFileURL(path.join(dir, relative)).href;
  const module = (await import(href)) as Record<string, unknown>;
  const exported = module.Command;

  ensure(
    typeof exported === 'function' && exported.prototype instanceof AbstractCommand,
    () =>
      new DefinitionError(
        `${relative} must export a Command class extending AbstractCommand`,
        {hint: `add "export class Command extends AbstractCommand { … }" to ${relative}`}
      )
  );

  const Ctor = exported as new () => AbstractCommand;
  const command = new Ctor();
  const expected = segments[segments.length - 1] ?? '';

  ensure(
    command.name === expected,
    () =>
      new DefinitionError(
        `${relative} declares name "${command.name}" but its file requires "${expected}"`,
        {hint: `rename the command to "${expected}", or move the file to "${command.name}.mts"`}
      )
  );

  return command;
}

function insert(
  root: CommandNode,
  segments: string[],
  command: AbstractCommand
): void {
  let node = root;
  for (const segment of segments) {
    let child = node.children.get(segment);
    if (child === undefined) {
      child = makeNode(segment);
      node.children.set(segment, child);
    }
    node = child;
  }
  node.command = command;
}
```

Append to `index.mts`: `export * from './discovery.mts';`

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test` then `npm run typecheck` and `npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/dispatch/src/lib/command/discovery.mts plugins/dispatch/src/lib/command/__fixtures__ plugins/dispatch/src/lib/command/discovery.test.mts plugins/dispatch/src/lib/command/index.mts
git commit -m "feat: discover commands from the folder tree"
```

---

## Task 6: The runner (runCli)

**Files:**
- Create: `plugins/dispatch/src/lib/cli/cli.mts` (the empty placeholder exists — fill it)
- Delete: `plugins/dispatch/src/lib/cli/command.mts` (superseded by `lib/command/`)
- Modify: `plugins/dispatch/src/lib/cli/index.mts` (already `export * from './cli.mts';` — leave as is)
- Test: `plugins/dispatch/src/lib/cli/cli.test.mts` (the empty placeholder exists — fill it)

**Interfaces:**
- Consumes: `discover` result `CommandNode`, `parseOptions`, `assertEnv`, `AbstractCommand`, `Option` from `../command/index.mts`; `Logger` from `../logger/index.mts`; `DispatchError`, `UsageError`, `assertUsage` from `../errors/index.mts`.
- Produces: `interface RunCliOptions {argv: readonly string[]; tree: CommandNode; log: Logger; env: NodeJS.ProcessEnv; stdout: Writable; stderr: Writable}`. `function runCli(options: RunCliOptions): Promise<number>` — returns the exit code.

- [ ] **Step 1: Write the failing E2E tests**

These run the framework end to end against the Task 5 fixtures. `cli.test.mts`:

```ts
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {runCli} from './cli.mts';
import {discover} from '../command/index.mts';
import {createLogger, type CoreLogger} from '../logger/index.mts';

const FIXTURES = new URL('../command/__fixtures__/commands/', import.meta.url);
const LEVELS = ['error', 'warn', 'info', 'debug', 'trace', 'log'] as const;

function capture(): {stream: Writable; text: () => string} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {stream, text: () => chunks.join('')};
}

function recordingLog(): {log: ReturnType<typeof createLogger>; lines: string[]} {
  const lines: string[] = [];
  const sink = {} as CoreLogger;
  for (const level of LEVELS) {
    sink[level] = (message: string) => {
      lines.push(message);
    };
  }
  return {log: createLogger(sink), lines};
}

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const tree = await discover(FIXTURES);
  const out = capture();
  const err = capture();
  const {log, lines} = recordingLog();
  const code = await runCli({argv, tree, log, env, stdout: out.stream, stderr: err.stream});
  return {code, out: out.text(), err: err.text(), lines};
}

describe('runCli', () => {
  it('dispatches a leaf command and applies defaults', async () => {
    const {code, lines} = await run(['greet']);
    assert.equal(code, 0);
    assert.deepEqual(lines, ['hello world']);
  });

  it('binds a positional and validates a choice', async () => {
    const named = await run(['greet', 'Ada']);
    assert.deepEqual(named.lines, ['hello Ada']);

    const json = await run(['greet', 'Ada', '--format', 'json']);
    assert.deepEqual(json.lines, ['{"hello":"Ada"}']);

    const bad = await run(['greet', '--format', 'xml']);
    assert.equal(bad.code, 2);
  });

  it('coerces numbers and reports a missing required option', async () => {
    const ok = await run(['math', 'add', '--a', '2', '--b', '3']);
    assert.deepEqual(ok.lines, ['5']);

    const missing = await run(['math', 'add', '--a', '2']);
    assert.equal(missing.code, 2);

    const nonNumber = await run(['math', 'add', '--a', 'x', '--b', '3']);
    assert.equal(nonNumber.code, 2);
  });

  it('prefers a subcommand over the parent when both could match', async () => {
    const child = await run(['store', 'get', 'colour']);
    assert.deepEqual(child.lines, ['get colour']);

    const parent = await run(['store', 'colour']);
    assert.deepEqual(parent.lines, ['store colour']);

    const root = await run(['store']);
    assert.deepEqual(root.lines, ['store (root)']);
  });

  it('exits 2 on an unknown subcommand under a namespace', async () => {
    const {code, err} = await run(['math', 'nope']);
    assert.equal(code, 2);
    assert.match(err, /nope/);
  });

  it('resolves --help to the deepest command path, position-independent', async () => {
    const trailing = await run(['math', 'add', '--help']);
    assert.equal(trailing.code, 0);
    assert.match(trailing.out, /math add/);

    const leading = await run(['--help', 'math', 'add']);
    assert.equal(leading.code, 0);
    assert.match(leading.out, /math add/);
  });

  it('exits 2 on an unknown flag or unknown command', async () => {
    assert.equal((await run(['greet', '--nope'])).code, 2);
    assert.equal((await run(['nope'])).code, 2);
  });

  it('enforces declared environment', async () => {
    const present = await run(['needs-token'], {MY_TOKEN: 'x'});
    assert.equal(present.code, 0);
    assert.deepEqual(present.lines, ['ok']);

    const missing = await run(['needs-token'], {});
    assert.equal(missing.code, 3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `runCli` is not defined.

- [ ] **Step 3: Write the implementation**

`cli.mts`:

```ts
import {parseArgs} from 'node:util';
import type {Writable} from 'node:stream';

import type {Logger} from '../logger/index.mts';
import {parseOptions, assertEnv} from '../command/index.mts';
import type {AbstractCommand, CommandNode, Option} from '../command/index.mts';
import {DispatchError, UsageError, assertUsage} from '../errors/index.mts';

export interface RunCliOptions {
  readonly argv: readonly string[];
  readonly tree: CommandNode;
  readonly log: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

interface Walked {
  readonly path: string[];
  readonly node: CommandNode;
  readonly rest: string[];
}

/** Parse argv against the command tree, run the matched command, return an exit code. */
export async function runCli(options: RunCliOptions): Promise<number> {
  const {argv, tree, log, env, stdout, stderr} = options;
  try {
    const walked = walk(tree, argv);

    if (wantsHelp(argv)) {
      stdout.write(`${usageText(walked)}\n`);
      return 0;
    }

    const {node, rest, path} = walked;
    const command = node.command;

    if (command === undefined) {
      const label = path.length > 0 ? path.join(' ') : 'dispatch';
      const children = [...node.children.keys()].join(', ');
      throw new UsageError(
        rest.length > 0
          ? `unknown subcommand "${rest[0]}" for ${label}`
          : `${label} needs a subcommand`,
        {hint: `run one of: ${children}`}
      );
    }

    const parsed = parseCommandArgs(command, rest);
    assertEnv(command.env, env);
    await command.run(parsed, {log, env});
    return 0;
  } catch (error) {
    if (error instanceof DispatchError) {
      stderr.write(`error: ${error.toString()}\n`);
      return error.exitCode;
    }
    stderr.write(`error: ${String(error)}\n`);
    return 1;
  }
}

/** Descend the tree along leading command-name tokens, ignoring help flags. */
function walk(root: CommandNode, argv: readonly string[]): Walked {
  let node = root;
  const path: string[] = [];
  const tokens = [...argv];
  let index = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === '--') break;
    if (token === '--help' || token === '-h') continue;
    if (token.startsWith('-')) break;
    const child = node.children.get(token);
    if (child === undefined) break;
    node = child;
    path.push(token);
  }
  return {path, node, rest: tokens.slice(index)};
}

/** Whether `--help`/`-h` appears anywhere before a `--` terminator. */
function wantsHelp(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === '--') return false;
    if (token === '--help' || token === '-h') return true;
  }
  return false;
}

function parseCommandArgs(
  command: AbstractCommand,
  rest: readonly string[]
): Record<string, unknown> {
  const flagConfig: Record<string, {type: 'string' | 'boolean'}> = {};
  const positionalNames: string[] = [];
  for (const [key, option] of Object.entries(command.options)) {
    if (option.positional) {
      positionalNames.push(key);
    } else {
      flagConfig[key] = {type: option.type === 'boolean' ? 'boolean' : 'string'};
    }
  }

  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...rest],
      options: flagConfig,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    throw toUsageError(error);
  }

  assertUsage(
    positionals.length <= positionalNames.length,
    `unexpected argument: ${positionals[positionalNames.length] ?? ''}`
  );

  const raw: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) raw[key] = value;
  }
  positionalNames.forEach((name, position) => {
    const value = positionals[position];
    if (value !== undefined) raw[name] = value;
  });

  return parseOptions(command.options, raw);
}

/** Re-tag a `node:util` parse failure as a usage error; rethrow anything else. */
function toUsageError(error: unknown): UsageError {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS_')
  ) {
    return new UsageError(error.message, {cause: error});
  }
  throw error;
}

function usageText(walked: Walked): string {
  const {path, node} = walked;
  const invocation = ['dispatch', ...path].join(' ');
  const lines: string[] = [];

  if (node.command === undefined) {
    lines.push(`usage: ${invocation} <subcommand>`);
  } else {
    const parts = Object.entries(node.command.options).map(([key, option]) =>
      optionUsage(key, option)
    );
    lines.push(`usage: ${[invocation, ...parts].join(' ')}`);
    lines.push('');
    lines.push(node.command.summary);
  }

  if (node.children.size > 0) {
    lines.push('');
    lines.push('subcommands:');
    lines.push(...childLines(node));
  }

  return lines.join('\n');
}

function optionUsage(key: string, option: Option): string {
  if (option.positional) {
    const label = option.choices ? option.choices.join('|') : key;
    return option.required ? `<${label}>` : `[<${label}>]`;
  }
  if (option.type === 'boolean') {
    return `[--${key}]`;
  }
  const value = option.choices ? option.choices.join('|') : option.type;
  return option.required ? `--${key} <${value}>` : `[--${key} <${value}>]`;
}

function childLines(node: CommandNode): string[] {
  const names = [...node.children.keys()].sort();
  const width = Math.max(...names.map((name) => name.length));
  return names.map((name) => {
    const summary = node.children.get(name)?.command?.summary ?? '';
    return `  ${name.padEnd(width)}  ${summary}`.trimEnd();
  });
}
```

Delete the superseded stub:

```bash
git rm plugins/dispatch/src/lib/cli/command.mts
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck` and `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/dispatch/src/lib/cli/cli.mts plugins/dispatch/src/lib/cli/cli.test.mts plugins/dispatch/src/lib/cli/index.mts
git commit -m "feat: add the CLI runner with folder-tree dispatch"
```

---

## Task 7: Entry point and an example command

**Files:**
- Create: `plugins/dispatch/src/commands/greet.mts` (a real example command)
- Modify: `plugins/dispatch/src/main.mts` (the empty placeholder exists — fill it)
- Test: `plugins/dispatch/src/main.test.mts`

**Interfaces:**
- Consumes: `discover` from `./lib/command/index.mts`; `runCli` from `./lib/cli/index.mts`; `createLogger` from `./lib/logger/index.mts`.
- Produces: `main.mts` discovers `./commands/` and runs `runCli` against `process.argv`, setting `process.exitCode`. This task also confirms the real (non-fixture) `src/commands/` tree discovers and runs.

The automated test drives `discover` + `runCli` against the real `src/commands/` tree (validating the example command integrates). `main.mts` itself is a thin top-level-await entry — reading `process.argv`, writing `process.exitCode` — validated by the Step 5 smoke check rather than a unit test.

- [ ] **Step 1: Write the failing test**

`plugins/dispatch/src/main.test.mts`:

```ts
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {discover} from './lib/command/index.mts';
import {runCli} from './lib/cli/index.mts';
import {createLogger, type CoreLogger} from './lib/logger/index.mts';

const COMMANDS = new URL('./commands/', import.meta.url);

describe('src/commands tree', () => {
  it('discovers and runs the greet command', async () => {
    const tree = await discover(COMMANDS);
    const lines: string[] = [];
    const sink = {} as CoreLogger;
    for (const level of ['error', 'warn', 'info', 'debug', 'trace', 'log'] as const) {
      sink[level] = (message: string) => {
        lines.push(message);
      };
    }
    const noop = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const code = await runCli({
      argv: ['greet', 'Ada', '--loud'],
      tree,
      log: createLogger(sink),
      env: {},
      stdout: noop,
      stderr: noop,
    });

    assert.equal(code, 0);
    assert.deepEqual(lines, ['HELLO ADA']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/commands/` is empty, so `discover` finds no `greet` and `runCli` returns exit 2 (unknown command).

- [ ] **Step 3: Write the example command**

`plugins/dispatch/src/commands/greet.mts`:

```ts
import {AbstractCommand} from '../lib/command/index.mts';
import type {ParsedOptions, CommandContext} from '../lib/command/index.mts';

const options = {
  who: {type: 'string', description: 'Who to greet.', positional: true, required: false, default: 'world'},
  loud: {type: 'boolean', description: 'Shout the greeting.', positional: false, required: false},
} as const;

export class Command extends AbstractCommand {
  readonly name = 'greet';
  readonly summary = 'Print a friendly greeting.';
  readonly env = [];
  readonly options = options;

  async run(parsed: ParsedOptions<typeof options>, ctx: CommandContext): Promise<void> {
    const message = `hello ${parsed.who}`;
    ctx.log.info(parsed.loud ? message.toUpperCase() : message);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test` then `npm run typecheck` and `npm run lint`
Expected: PASS — the example command discovers and runs.

- [ ] **Step 5: Write the entry point and smoke-check it**

`plugins/dispatch/src/main.mts`:

```ts
import {discover} from './lib/command/index.mts';
import {runCli} from './lib/cli/index.mts';
import {createLogger} from './lib/logger/index.mts';

const tree = await discover(new URL('./commands/', import.meta.url));

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  tree,
  log: createLogger(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
```

Manual smoke check:

```bash
node plugins/dispatch/src/main.mts greet Ada --loud
```

Expected: prints `HELLO ADA` (via the default `console` logger on stdout). Also try `node plugins/dispatch/src/main.mts --help` and confirm it lists `greet`.

- [ ] **Step 6: Commit**

```bash
git add plugins/dispatch/src/commands/greet.mts plugins/dispatch/src/main.mts plugins/dispatch/src/main.test.mts
git commit -m "feat: wire the CLI entry point with an example command"
```

---

## Notes for the implementer

- **Import types, not values, under `verbatimModuleSyntax`.** `Option`, `CommandNode`, `Logger`, `ParsedOptions`, `CommandContext`, `Writable` are type-only imports (`import type`); `AbstractCommand` is imported as a value in `discovery.mts` (used with `instanceof` and `new`).
- **`node:util` `parseArgs` typing.** With a non-`const` `options` config object, `parsed.values` is `Record<string, string | boolean | undefined>` and `parsed.positionals` is `string[]`; the destructuring in `parseCommandArgs` relies on that. If `tsc` narrows it differently, annotate the two locals as written rather than casting to `any`.
- **`noUncheckedIndexedAccess`.** Every `array[i]`, `Map.get`, and `raw[key]` is `T | undefined`; the code above already guards each (`?? ''`, `if (value !== undefined)`, `?.`).
- **Do not add a `usage` field to commands.** Usage text is generated by `usageText`/`optionUsage` from `name` + `options`.
- **`schema.mts` is out of scope.** Leave the existing empty `src/schema.mts` untouched.
