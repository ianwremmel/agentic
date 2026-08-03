# Dispatch MCP transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose every dispatch command as an MCP tool over a hand-rolled stdio JSON-RPC server, reusing the existing command tree, with per-transport opt-out.

**Architecture:** Add two things to the transport-neutral `lib/command` core — an `Io` response channel on `CommandContext` and a `transports` gate on `AbstractCommand`. Then add `lib/mcp/`, a second transport (sibling of `lib/cli/`) that walks the same `CommandNode` tree into MCP tool definitions and runs a JSON-RPC 2.0 loop over stdio. A new `mcp` command starts the server and is the first command to opt out of MCP.

**Tech Stack:** TypeScript `.mts` on Node's native type stripping (no build step, no runtime deps), `node:readline`, `node:test`, `node:assert/strict`.

## Global Constraints

- Node `>=24.18.0`; `.mts` files run unbuilt — import siblings by real path with extension (`./tools.mts`).
- **No runtime dependencies.** The JSON-RPC server is hand-rolled on `node:readline` + `JSON`. Do not add `@modelcontextprotocol/sdk` or any package.
- One exported class/function per file (utility files may group closely-related functions); each `lib` folder has an `index.mts` barrel; keep files under ~200 lines.
- `strict` and `noImplicitOverride` are on: overriding the concrete `transports` field requires the `override` keyword; implementing the `abstract` members does not.
- Tests: mock i/o, not imports; each test fails only when one specific rule breaks.
- Commands are discovered by folder path; a file's `name` must equal its basename.
- Conventional-commit messages. No `Co-Authored-By`/`Generated with` trailers.
- Verify before each commit: `npm run lint && npm run typecheck && npm test` from repo root.
- Spec: `docs/superpowers/specs/2026-07-29-mcp-transport-design.md`.

---

## File Structure

```text
plugins/dispatch/src/
  lib/command/
    abstract-command.mts   # MODIFY: add Io interface, io on CommandContext, transports field
    transports.mts         # CREATE: resolveTransports() + ResolvedTransports
    index.mts              # MODIFY: export transports.mts
    __fixtures__/commands/
      mcp-only.mts         # CREATE: transports {cli:false} — mcp-visible, cli-hidden
      cli-only.mts         # CREATE: transports {mcp:false} — cli-visible, mcp-hidden
  lib/cli/
    cli.mts                # MODIFY: build stdout-backed io; honor transports.cli
    cli.test.mts           # MODIFY: assert stdout (out) not logger lines; gating tests
  lib/mcp/
    tools.mts              # CREATE: buildTools(tree) -> {defs, byName}, inputSchema
    dispatch.mts           # CREATE: callTool(command, args, ctx) -> ToolResult
    json-rpc-error.mts     # CREATE: JsonRpcError
    mcp.mts                # CREATE: runMcpServer(): JSON-RPC loop + handlers
    tools.test.mts         # CREATE
    dispatch.test.mts      # CREATE
    mcp.test.mts           # CREATE
    index.mts              # CREATE: barrel
    CLAUDE.md              # CREATE: short pointer
  commands/
    greet.mts              # MODIFY: emit via io
    mcp.mts                # CREATE: starts the server, transports {mcp:false}
  main.test.mts            # MODIFY: greet asserts stdout; mcp-exclusion test
```

---

## Task 1: Transport gating in `lib/command`

**Files:**
- Create: `plugins/dispatch/src/lib/command/transports.mts`
- Create: `plugins/dispatch/src/lib/command/transports.test.mts`
- Modify: `plugins/dispatch/src/lib/command/abstract-command.mts` (add `transports` field to the class)
- Modify: `plugins/dispatch/src/lib/command/index.mts` (barrel)

**Interfaces:**
- Consumes: `AbstractCommand` from `./abstract-command.mts`.
- Produces: `resolveTransports(command: AbstractCommand): ResolvedTransports` where `ResolvedTransports = {readonly cli: boolean; readonly mcp: boolean}`; and a new concrete field `readonly transports: {readonly cli?: boolean; readonly mcp?: boolean} = {}` on `AbstractCommand`.

- [ ] **Step 1: Write the failing test**

Create `plugins/dispatch/src/lib/command/transports.test.mts`:

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {AbstractCommand} from './abstract-command.mts';
import {resolveTransports} from './transports.mts';

class Base extends AbstractCommand {
  readonly name = 'x';
  readonly summary = 's';
  readonly env = [];
  readonly options = {} as const;
  run(): Promise<void> {
    return Promise.resolve();
  }
}

class NoMcp extends Base {
  override readonly transports = {mcp: false} as const;
}

describe('resolveTransports', () => {
  it('defaults both transports to available', () => {
    assert.deepEqual(resolveTransports(new Base()), {cli: true, mcp: true});
  });

  it('keeps the unstated side available when one opts out', () => {
    assert.deepEqual(resolveTransports(new NoMcp()), {cli: true, mcp: false});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/command/transports.test.mts`
Expected: FAIL — `resolveTransports` / `transports` do not exist yet.

- [ ] **Step 3: Add the `transports` field to `AbstractCommand`**

In `abstract-command.mts`, add a concrete field inside the class, after the `abstract run(...)` declaration:

```ts
  /** Transport availability; absent side defaults to available. Read through
   *  `resolveTransports`, never directly. */
  readonly transports: {readonly cli?: boolean; readonly mcp?: boolean} = {};
```

- [ ] **Step 4: Create `transports.mts`**

```ts
import type {AbstractCommand} from './abstract-command.mts';

export interface ResolvedTransports {
  readonly cli: boolean;
  readonly mcp: boolean;
}

/**
 * A command's transport availability with defaults filled in, so gating code
 * reads definite booleans instead of an optional partial. An unstated
 * transport is available.
 */
export function resolveTransports(command: AbstractCommand): ResolvedTransports {
  return {cli: true, mcp: true, ...command.transports};
}
```

- [ ] **Step 5: Export from the barrel**

In `index.mts` add:

```ts
export * from './transports.mts';
```

- [ ] **Step 6: Run tests, lint, typecheck**

Run: `node --test plugins/dispatch/src/lib/command/transports.test.mts`
Expected: PASS.
Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add plugins/dispatch/src/lib/command/
git commit -m "feat: add per-command transport gating"
```

---

## Task 2: The `io` response channel + CLI wiring

Additive: adds `Io` to the contract, has `runCli` supply a stdout-backed `io`, and migrates the real `greet` command to prove it end-to-end. Fixture commands stay on `log` until Task 3, so `cli.test.mts` stays green.

**Files:**
- Modify: `plugins/dispatch/src/lib/command/abstract-command.mts` (add `Io`, add `io` to `CommandContext`)
- Modify: `plugins/dispatch/src/lib/cli/cli.mts` (build `io`, pass in context)
- Modify: `plugins/dispatch/src/commands/greet.mts` (emit via `io`)
- Modify: `plugins/dispatch/src/main.test.mts` (assert captured stdout)
- Modify: `plugins/dispatch/src/lib/command/CLAUDE.md` (document `io` + `transports`/`resolveTransports`)

**Interfaces:**
- Consumes: `resolveTransports` (from Task 1) is not used here; `CommandContext` from `./abstract-command.mts`.
- Produces: `interface Io {write(chunk: string): void}`; `CommandContext` now `{readonly log: Logger; readonly env: NodeJS.ProcessEnv; readonly io: Io}`. `runCli` unchanged in signature; internally it constructs `io` from its `stdout`.

- [ ] **Step 1: Update the failing test**

Replace the assertion in `plugins/dispatch/src/main.test.mts` so greet's output is read from captured stdout, not the logger. Change the stdout sink to record and assert it:

```ts
    const out: string[] = [];
    const sink2 = new Writable({
      write(chunk, _encoding, callback) {
        out.push(String(chunk));
        callback();
      },
    });

    const code = await runCli({
      argv: ['greet', 'Ada', '--loud'],
      tree,
      log: createLogger(sink),
      env: {},
      stdout: sink2,
      stderr: noop,
    });

    assert.equal(code, 0);
    assert.equal(out.join(''), 'HELLO ADA\n');
```

(Remove the now-unused `lines`/`sink` recording-logger assertion for this test; keep whatever the test still references so it compiles.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/main.test.mts`
Expected: FAIL — greet still writes to `log`, so captured stdout is empty.

- [ ] **Step 3: Add `Io` and thread it through the contract**

In `abstract-command.mts`, add above `CommandContext`:

```ts
/**
 * The command's response channel, distinct from `log` (diagnostics). The cli
 * writes it to stdout; the MCP server captures it as the tool result.
 */
export interface Io {
  write(chunk: string): void;
}
```

Then add `io` to `CommandContext`:

```ts
export interface CommandContext {
  readonly log: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly io: Io;
}
```

- [ ] **Step 4: Build `io` in `runCli`**

In `cli.mts`, replace the run call (currently `await command.run(parsed, {log, env});`) with:

```ts
    const io = {
      write: (chunk: string) => {
        stdout.write(chunk);
      },
    };
    await command.run(parsed, {log, env, io});
```

- [ ] **Step 5: Migrate the real `greet` command to `io`**

In `commands/greet.mts`, change the `run` body from logging to writing:

```ts
  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const message = `hello ${parsed.who}`;
    ctx.io.write(`${parsed.loud ? message.toUpperCase() : message}\n`);
  }
```

(The `eslint-disable-next-line @typescript-eslint/require-await` comment above `run` stays — the body still has no `await`.)

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/main.test.mts`
Expected: PASS.

- [ ] **Step 7: Update `lib/command/CLAUDE.md`**

Add two short bullets to the existing list (keep it a pointer, not prose):

```markdown
- `abstract-command.mts` — also defines `Io` (the command's response channel,
  distinct from `log`) on `CommandContext`, and the concrete `transports` field.
- `transports.mts` — `resolveTransports(command)` fills the `transports` partial
  with `{cli: true, mcp: true}` defaults so gating reads definite booleans.
```

- [ ] **Step 8: Lint, typecheck, full test**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass (fixtures still use `log`; `cli.test.mts` unaffected).

- [ ] **Step 9: Commit**

```bash
git add plugins/dispatch/src/lib/command/ plugins/dispatch/src/lib/cli/cli.mts plugins/dispatch/src/commands/greet.mts plugins/dispatch/src/main.test.mts
git commit -m "feat: add io response channel distinct from logging"
```

---

## Task 3: Migrate fixture commands to `io`

Consistency pass: fixture commands emit responses via `io`, and `cli.test.mts` asserts captured stdout. This makes the whole codebase treat `log` as diagnostics only.

**Files:**
- Modify: `plugins/dispatch/src/lib/command/__fixtures__/commands/greet.mts`, `store.mts`, `store/get.mts`, `math/add.mts`, `needs-token.mts`
- Modify: `plugins/dispatch/src/lib/cli/cli.test.mts`

**Interfaces:**
- Consumes: `Io` on `CommandContext` (Task 2).
- Produces: nothing new; fixture output now lands on `stdout`.

- [ ] **Step 1: Rewrite `cli.test.mts` to assert stdout**

Replace the whole file with (the only change is assertions move from `lines` to `out`, and the recording logger is dropped):

```ts
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {runCli} from './cli.mts';
import {discover} from '../command/index.mts';
import {createLogger} from '../logger/index.mts';

const FIXTURES = new URL('../command/__fixtures__/commands/', import.meta.url);

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

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const tree = await discover(FIXTURES);
  const out = capture();
  const err = capture();
  const code = await runCli({
    argv,
    tree,
    log: createLogger(capture().stream as unknown as Console),
    env,
    stdout: out.stream,
    stderr: err.stream,
  });
  return {code, out: out.text(), err: err.text()};
}

describe('runCli', () => {
  it('dispatches a leaf command and applies defaults', async () => {
    const {code, out} = await run(['greet']);
    assert.equal(code, 0);
    assert.equal(out, 'hello world\n');
  });

  it('binds a positional and validates a choice', async () => {
    assert.equal((await run(['greet', 'Ada'])).out, 'hello Ada\n');
    assert.equal((await run(['greet', 'Ada', '--format', 'json'])).out, '{"hello":"Ada"}\n');
    assert.equal((await run(['greet', '--format', 'xml'])).code, 2);
  });

  it('coerces numbers and reports a missing required option', async () => {
    assert.equal((await run(['math', 'add', '--a', '2', '--b', '3'])).out, '5\n');
    assert.equal((await run(['math', 'add', '--a', '2'])).code, 2);
    assert.equal((await run(['math', 'add', '--a', 'x', '--b', '3'])).code, 2);
  });

  it('prefers a subcommand over the parent when both could match', async () => {
    assert.equal((await run(['store', 'get', 'colour'])).out, 'get colour\n');
    assert.equal((await run(['store', 'colour'])).out, 'store colour\n');
    assert.equal((await run(['store'])).out, 'store (root)\n');
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
    assert.equal(present.out, 'ok\n');

    assert.equal((await run(['needs-token'], {})).code, 3);
  });
});
```

Note: `createLogger(capture().stream as unknown as Console)` just gives the logger a throwaway sink — fixture output no longer goes through the logger, so its destination is irrelevant. If the cast trips lint, instead build a no-op `CoreLogger` object (six methods that ignore their args) as in the original file's `recordingLog` and pass that.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/cli/cli.test.mts`
Expected: FAIL — fixtures still write to `log`, so `out` is empty.

- [ ] **Step 3: Migrate each fixture command's output**

In each fixture, replace the `ctx.log.info(x)` call with `ctx.io.write(\`${x}\n\`)`:

- `greet.mts` — `ctx.io.write(\`${JSON.stringify({hello: parsed.who})}\n\`)` in the json branch, `ctx.io.write(\`hello ${parsed.who}\n\`)` otherwise.
- `store.mts` — `ctx.io.write(\`store ${parsed.key ?? '(root)'}\n\`)`.
- `store/get.mts` — `ctx.io.write(\`get ${parsed.key}\n\`)`.
- `math/add.mts` — `ctx.io.write(\`${String(parsed.a + parsed.b)}\n\`)`.
- `needs-token.mts` — `ctx.io.write('ok\n')`.

Keep the existing `eslint-disable-next-line @typescript-eslint/require-await` comment above each `run`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/cli/cli.test.mts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, full test**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/dispatch/src/lib/command/__fixtures__/ plugins/dispatch/src/lib/cli/cli.test.mts
git commit -m "refactor: emit fixture command output through io"
```

---

## Task 4: CLI honors `transports.cli`

`runCli` hides and refuses commands whose `cli` transport is off. Adds the `mcp-only` fixture (`transports {cli:false}`) as the subject.

**Files:**
- Create: `plugins/dispatch/src/lib/command/__fixtures__/commands/mcp-only.mts`
- Modify: `plugins/dispatch/src/lib/cli/cli.mts` (refuse + hide gated commands)
- Modify: `plugins/dispatch/src/lib/cli/cli.test.mts` (gating tests)
- Modify: `plugins/dispatch/src/lib/cli/CLAUDE.md` (note gating + io)

**Interfaces:**
- Consumes: `resolveTransports` (Task 1).
- Produces: no new exports; behavior — a command with `resolveTransports(command).cli === false` is treated by `runCli` as absent (exit 2 on invoke, omitted from generated subcommand listings).

- [ ] **Step 1: Create the fixture**

`plugins/dispatch/src/lib/command/__fixtures__/commands/mcp-only.mts`:

```ts
import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {} as const;

export class Command extends AbstractCommand {
  readonly name = 'mcp-only';
  readonly summary = 'Reachable over MCP only.';
  readonly env = [];
  readonly options = options;
  override readonly transports = {cli: false};

  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    _parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    ctx.io.write('mcp-only ran\n');
  }
}
```

- [ ] **Step 2: Write the failing tests**

Add to `cli.test.mts` inside `describe('runCli', …)`:

```ts
  it('hides and refuses a command that opts out of cli', async () => {
    const invoked = await run(['mcp-only']);
    assert.equal(invoked.code, 2);

    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.doesNotMatch(help.out, /mcp-only/);
    assert.match(help.out, /greet/);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/cli/cli.test.mts`
Expected: FAIL — `mcp-only` currently runs (exit 0) and shows in help.

- [ ] **Step 4: Enforce the gate in `cli.mts`**

Import the resolver:

```ts
import {parseOptions, assertEnv, resolveTransports} from '../command/index.mts';
```

In `runCli`, after `const command = node.command;` treat a cli-disabled command as if the node had no command. Replace the `if (command === undefined)` guard so it also fires when the command is cli-gated:

```ts
    if (command === undefined || !resolveTransports(command).cli) {
      const label = path.length > 0 ? path.join(' ') : 'dispatch';
      const children = visibleChildNames(node).join(', ');
      throw new UsageError(
        rest.length > 0
          ? `unknown subcommand "${rest[0] ?? ''}" for ${label}`
          : `${label} needs a subcommand`,
        {hint: `run one of: ${children}`}
      );
    }
```

Add a helper that lists only cli-visible child names (a child is visible if it has no command, i.e. a pure namespace, or its command's `cli` transport is on):

```ts
function visibleChildNames(node: CommandNode): string[] {
  return [...node.children.entries()]
    .filter(([, child]) => {
      const cmd = child.command;
      return cmd === undefined || resolveTransports(cmd).cli;
    })
    .map(([name]) => name)
    .sort();
}
```

In `childLines`, filter the names the same way so generated help omits gated commands:

```ts
function childLines(node: CommandNode): string[] {
  const names = visibleChildNames(node);
  if (names.length === 0) return [];
  const width = Math.max(...names.map((name) => name.length));
  return names.map((name) => {
    const summary = node.children.get(name)?.command?.summary ?? '';
    return `  ${name.padEnd(width)}  ${summary}`.trimEnd();
  });
}
```

(The existing `[...node.children.keys()].join(', ')` inside the original guard is replaced by `visibleChildNames(node).join(', ')` as shown above. In `usageText`, the `node.children.size > 0` check still gates whether the "subcommands:" block prints; that is acceptable — a namespace with only hidden children prints an empty block header at worst. If you want it exact, guard on `visibleChildNames(node).length > 0` there too.)

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/cli/cli.test.mts`
Expected: PASS. Confirm the pre-existing "unknown subcommand under a namespace" and "unknown command" tests still pass.

- [ ] **Step 6: Update `lib/cli/CLAUDE.md`**

Append one line to the existing description:

```markdown
`runCli` also supplies each command an `io` bound to `stdout` (its response
channel, separate from `log`) and hides/refuses any command whose `cli`
transport is off (`resolveTransports`).
```

- [ ] **Step 7: Lint, typecheck, full test**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add plugins/dispatch/src/lib/cli/ plugins/dispatch/src/lib/command/__fixtures__/commands/mcp-only.mts
git commit -m "feat: hide and refuse cli-gated commands"
```

---

## Task 5: Tool generation — `lib/mcp/tools.mts`

Walks the tree into MCP tool defs + a name→command map. Adds the `cli-only` fixture (`transports {mcp:false}`) as the exclusion subject.

**Files:**
- Create: `plugins/dispatch/src/lib/mcp/tools.mts`
- Create: `plugins/dispatch/src/lib/mcp/tools.test.mts`
- Create: `plugins/dispatch/src/lib/command/__fixtures__/commands/cli-only.mts`

**Interfaces:**
- Consumes: `CommandNode`, `AbstractCommand`, `Option`, `resolveTransports` from `../command/index.mts`.
- Produces:
  - `interface ToolDef {readonly name: string; readonly description: string; readonly inputSchema: JsonSchema}`
  - `interface JsonSchema {readonly type: 'object'; readonly properties: Record<string, PropertySchema>; readonly required?: readonly string[]}`
  - `interface BuiltTools {readonly defs: readonly ToolDef[]; readonly byName: ReadonlyMap<string, AbstractCommand>}`
  - `function buildTools(tree: CommandNode): BuiltTools`

- [ ] **Step 1: Create the `cli-only` fixture**

`plugins/dispatch/src/lib/command/__fixtures__/commands/cli-only.mts`:

```ts
import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {} as const;

export class Command extends AbstractCommand {
  readonly name = 'cli-only';
  readonly summary = 'Reachable over cli only.';
  readonly env = [];
  readonly options = options;
  override readonly transports = {mcp: false};

  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    _parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    ctx.io.write('cli-only ran\n');
  }
}
```

Note: this adds a cli-visible top-level command. It does not break `cli.test.mts` (no test enumerates the full command set), but re-run the full suite in Step 6 to confirm.

- [ ] **Step 2: Write the failing test**

`plugins/dispatch/src/lib/mcp/tools.test.mts`:

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {discover} from '../command/index.mts';
import {buildTools} from './tools.mts';

const FIXTURES = new URL('../command/__fixtures__/commands/', import.meta.url);

describe('buildTools', () => {
  it('names tools by underscore-joined path and emits one per runnable node', async () => {
    const {defs} = buildTools(await discover(FIXTURES));
    const names = defs.map((d) => d.name);
    assert.ok(names.includes('greet'));
    assert.ok(names.includes('store'));
    assert.ok(names.includes('store_get'));
    assert.ok(names.includes('math_add'));
  });

  it('includes a cli-opted-out command but excludes an mcp-opted-out one', async () => {
    const {defs, byName} = buildTools(await discover(FIXTURES));
    const names = defs.map((d) => d.name);
    assert.ok(names.includes('mcp-only')); // cli:false, still on mcp
    assert.ok(!names.includes('cli-only')); // mcp:false, excluded
    assert.equal(byName.get('math_add')?.name, 'add');
  });

  it('maps options to a JSON Schema with types, enum, default, and required', async () => {
    const {defs} = buildTools(await discover(FIXTURES));
    const greet = defs.find((d) => d.name === 'greet');
    assert.ok(greet);
    assert.equal(greet.inputSchema.properties.who.type, 'string');
    assert.equal(greet.inputSchema.properties.who.default, 'world');
    assert.deepEqual(greet.inputSchema.properties.format.enum, ['text', 'json']);
    assert.equal(greet.inputSchema.required, undefined); // both greet options optional

    const add = defs.find((d) => d.name === 'math_add');
    assert.deepEqual(add?.inputSchema.required, ['a', 'b']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/mcp/tools.test.mts`
Expected: FAIL — `tools.mts` does not exist.

- [ ] **Step 4: Implement `tools.mts`**

```ts
import type {
  CommandNode,
  AbstractCommand,
  Option,
} from '../command/index.mts';
import {resolveTransports} from '../command/index.mts';

interface PropertySchema {
  type: 'string' | 'number' | 'boolean';
  description: string;
  enum?: readonly string[];
  default?: string | number | boolean;
}

export interface JsonSchema {
  readonly type: 'object';
  readonly properties: Record<string, PropertySchema>;
  readonly required?: readonly string[];
}

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface BuiltTools {
  readonly defs: readonly ToolDef[];
  readonly byName: ReadonlyMap<string, AbstractCommand>;
}

/** Walk the command tree into MCP tool defs plus a name -> command lookup. */
export function buildTools(tree: CommandNode): BuiltTools {
  const defs: ToolDef[] = [];
  const byName = new Map<string, AbstractCommand>();
  walk(tree, [], defs, byName);
  return {defs, byName};
}

function walk(
  node: CommandNode,
  path: string[],
  defs: ToolDef[],
  byName: Map<string, AbstractCommand>
): void {
  const command = node.command;
  if (command !== undefined && resolveTransports(command).mcp) {
    const name = path.join('_');
    defs.push({
      name,
      description: command.summary,
      inputSchema: inputSchema(command),
    });
    byName.set(name, command);
  }
  for (const [segment, child] of node.children) {
    walk(child, [...path, segment], defs, byName);
  }
}

function inputSchema(command: AbstractCommand): JsonSchema {
  const properties: Record<string, PropertySchema> = {};
  const required: string[] = [];
  for (const [key, option] of Object.entries(command.options)) {
    properties[key] = propertySchema(option);
    if (option.required) required.push(key);
  }
  return required.length > 0
    ? {type: 'object', properties, required}
    : {type: 'object', properties};
}

function propertySchema(option: Option): PropertySchema {
  const schema: PropertySchema = {
    type: option.type,
    description: option.description,
  };
  if (option.choices !== undefined) schema.enum = option.choices;
  if (option.default !== undefined) schema.default = option.default;
  return schema;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/mcp/tools.test.mts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, full test**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass (including the untouched `cli.test.mts`).

- [ ] **Step 7: Commit**

```bash
git add plugins/dispatch/src/lib/mcp/tools.mts plugins/dispatch/src/lib/mcp/tools.test.mts plugins/dispatch/src/lib/command/__fixtures__/commands/cli-only.mts
git commit -m "feat: generate mcp tool defs from the command tree"
```

---

## Task 6: Call dispatch — `json-rpc-error.mts` + `dispatch.mts`

`callTool` runs one command with a capturing `io`, returning an MCP tool result; a `DispatchError` becomes an `isError` result. `JsonRpcError` is added here for the server loop (Task 7) to throw.

**Files:**
- Create: `plugins/dispatch/src/lib/mcp/json-rpc-error.mts`
- Create: `plugins/dispatch/src/lib/mcp/dispatch.mts`
- Create: `plugins/dispatch/src/lib/mcp/dispatch.test.mts`

**Interfaces:**
- Consumes: `AbstractCommand`, `Io`, `parseOptions`, `assertEnv` from `../command/index.mts`; `Logger` from `../logger/index.mts`; `DispatchError` from `../errors/index.mts`.
- Produces:
  - `class JsonRpcError extends Error {readonly code: number; constructor(code: number, message: string)}`
  - `interface ToolResult {readonly content: readonly {readonly type: 'text'; readonly text: string}[]; readonly isError?: boolean}`
  - `interface CallToolContext {readonly env: NodeJS.ProcessEnv; readonly log: Logger}`
  - `function callTool(command: AbstractCommand, args: Readonly<Record<string, unknown>>, ctx: CallToolContext): Promise<ToolResult>`

- [ ] **Step 1: Write the failing test**

`plugins/dispatch/src/lib/mcp/dispatch.test.mts`:

```ts
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {AbstractCommand} from '../command/index.mts';
import type {ParsedOptions, CommandContext} from '../command/index.mts';
import {createLogger, type CoreLogger} from '../logger/index.mts';
import {callTool} from './dispatch.mts';

const nullLog = () => {
  const noop = () => undefined;
  const sink = {} as CoreLogger;
  for (const level of ['error', 'warn', 'info', 'debug', 'trace', 'log'] as const) {
    sink[level] = noop;
  }
  return createLogger(sink);
};

const echoOptions = {
  msg: {type: 'string', description: 'd', positional: false, required: true},
} as const;

class Echo extends AbstractCommand {
  readonly name = 'echo';
  readonly summary = 's';
  readonly env = [];
  readonly options = echoOptions;
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(parsed: ParsedOptions<typeof echoOptions>, ctx: CommandContext): Promise<void> {
    ctx.io.write(`echo ${parsed.msg}`);
  }
}

class NeedsEnv extends AbstractCommand {
  readonly name = 'needs';
  readonly summary = 's';
  readonly env = ['TOK'];
  readonly options = {} as const;
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(_parsed: Record<string, unknown>, ctx: CommandContext): Promise<void> {
    ctx.io.write('ran');
  }
}

describe('callTool', () => {
  it('returns the command io output as text', async () => {
    const result = await callTool(new Echo(), {msg: 'hi'}, {env: {}, log: nullLog()});
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, 'echo hi');
  });

  it('returns isError when a required option is missing', async () => {
    const result = await callTool(new Echo(), {}, {env: {}, log: nullLog()});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /msg/);
  });

  it('returns isError when a declared env var is missing', async () => {
    const result = await callTool(new NeedsEnv(), {}, {env: {}, log: nullLog()});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /TOK/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/mcp/dispatch.test.mts`
Expected: FAIL — `dispatch.mts` does not exist.

- [ ] **Step 3: Implement `json-rpc-error.mts`**

```ts
/**
 * A JSON-RPC protocol failure (bad method, malformed request, unknown tool).
 * The server loop renders it into an `error` response. Distinct from a tool's
 * own failure, which is a successful result carrying `isError: true`.
 */
export class JsonRpcError extends Error {
  override readonly name = 'JsonRpcError';
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
```

- [ ] **Step 4: Implement `dispatch.mts`**

```ts
import type {AbstractCommand, Io} from '../command/index.mts';
import {parseOptions, assertEnv} from '../command/index.mts';
import type {Logger} from '../logger/index.mts';
import {DispatchError} from '../errors/index.mts';

export interface ToolResult {
  readonly content: readonly {readonly type: 'text'; readonly text: string}[];
  readonly isError?: boolean;
}

export interface CallToolContext {
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
}

/**
 * Run one command from JSON tool input. Output written to `io` becomes the
 * result text; a `DispatchError` (bad input, missing env) becomes an `isError`
 * result rather than throwing, mirroring how the cli maps it to an exit code.
 */
export async function callTool(
  command: AbstractCommand,
  args: Readonly<Record<string, unknown>>,
  ctx: CallToolContext
): Promise<ToolResult> {
  let captured = '';
  const io: Io = {
    write: (chunk) => {
      captured += chunk;
    },
  };

  try {
    const raw: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined) continue;
      raw[key] = typeof value === 'boolean' ? value : String(value);
    }
    const parsed = parseOptions(command.options, raw);
    assertEnv(command.env, ctx.env);
    await command.run(parsed, {log: ctx.log, env: ctx.env, io});
    return {content: [{type: 'text', text: captured}]};
  } catch (error) {
    const text =
      error instanceof DispatchError ? error.toString() : String(error);
    return {content: [{type: 'text', text}], isError: true};
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/mcp/dispatch.test.mts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, full test**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add plugins/dispatch/src/lib/mcp/json-rpc-error.mts plugins/dispatch/src/lib/mcp/dispatch.mts plugins/dispatch/src/lib/mcp/dispatch.test.mts
git commit -m "feat: dispatch mcp tool calls to commands"
```

---

## Task 7: The server loop — `lib/mcp/mcp.mts` + barrel

`runMcpServer` reads newline-delimited JSON-RPC from stdin, dispatches by method, writes responses to stdout, and logs to stderr.

**Files:**
- Create: `plugins/dispatch/src/lib/mcp/mcp.mts`
- Create: `plugins/dispatch/src/lib/mcp/mcp.test.mts`
- Create: `plugins/dispatch/src/lib/mcp/index.mts`
- Create: `plugins/dispatch/src/lib/mcp/CLAUDE.md`

**Interfaces:**
- Consumes: `CommandNode` from `../command/index.mts`; `createLogger`, `CoreLogger` from `../logger/index.mts`; `buildTools` (Task 5), `callTool` (Task 6), `JsonRpcError` (Task 6).
- Produces: `function runMcpServer(opts: {tree: CommandNode; stdin: Readable; stdout: Writable; stderr: Writable; env: NodeJS.ProcessEnv}): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`plugins/dispatch/src/lib/mcp/mcp.test.mts`:

```ts
import assert from 'node:assert/strict';
import {Readable, Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {discover} from '../command/index.mts';
import {runMcpServer} from './mcp.mts';

const FIXTURES = new URL('../command/__fixtures__/commands/', import.meta.url);

function feed(messages: unknown[]): Readable {
  return Readable.from(messages.map((m) => `${JSON.stringify(m)}\n`));
}

function feedRaw(lines: string[]): Readable {
  return Readable.from(lines.map((l) => `${l}\n`));
}

const nullStream = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

async function serve(stdin: Readable, env: NodeJS.ProcessEnv = {}) {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  await runMcpServer({
    tree: await discover(FIXTURES),
    stdin,
    stdout,
    stderr: nullStream(),
    env,
  });
  return chunks
    .join('')
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, any>);
}

describe('runMcpServer', () => {
  it('handshakes and lists generated tools', async () => {
    const res = await serve(
      feed([
        {jsonrpc: '2.0', id: 1, method: 'initialize', params: {}},
        {jsonrpc: '2.0', id: 2, method: 'tools/list'},
      ])
    );
    assert.equal(res[0].result.protocolVersion, '2025-06-18');
    assert.ok(res[1].result.tools.some((t: {name: string}) => t.name === 'store_get'));
  });

  it('runs a tool and returns its captured output', async () => {
    const res = await serve(
      feed([{jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'greet', arguments: {who: 'Ada'}}}])
    );
    assert.match(res[0].result.content[0].text, /hello Ada/);
    assert.equal(res[0].result.isError, undefined);
  });

  it('reports a command failure as an isError result, not a protocol error', async () => {
    const res = await serve(
      feed([{jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'math_add', arguments: {a: '2'}}}])
    );
    assert.equal(res[0].result.isError, true);
    assert.equal(res[0].error, undefined);
  });

  it('reports a missing env var as an isError result', async () => {
    const res = await serve(
      feed([{jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'needs-token', arguments: {}}}])
    );
    assert.equal(res[0].result.isError, true);
    assert.match(res[0].result.content[0].text, /MY_TOKEN/);
  });

  it('rejects an unknown method with -32601', async () => {
    const res = await serve(feed([{jsonrpc: '2.0', id: 9, method: 'bogus'}]));
    assert.equal(res[0].error.code, -32601);
  });

  it('rejects an unknown tool with -32602', async () => {
    const res = await serve(
      feed([{jsonrpc: '2.0', id: 9, method: 'tools/call', params: {name: 'nope'}}])
    );
    assert.equal(res[0].error.code, -32602);
  });

  it('survives a malformed line and processes the next request', async () => {
    const res = await serve(
      feedRaw(['not json', JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'})])
    );
    assert.equal(res[0].error.code, -32700);
    assert.ok(res[1].result.tools);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/lib/mcp/mcp.test.mts`
Expected: FAIL — `mcp.mts` does not exist.

- [ ] **Step 3: Implement `mcp.mts`**

```ts
import readline from 'node:readline';
import type {Readable, Writable} from 'node:stream';

import type {CommandNode} from '../command/index.mts';
import {createLogger} from '../logger/index.mts';
import type {CoreLogger, Logger} from '../logger/index.mts';
import {buildTools} from './tools.mts';
import type {BuiltTools} from './tools.mts';
import {callTool} from './dispatch.mts';
import {JsonRpcError} from './json-rpc-error.mts';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = {name: 'dispatch', version: '1.0.0'};
const LEVELS = ['error', 'warn', 'info', 'debug', 'trace', 'log'] as const;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface RequestContext {
  readonly tools: BuiltTools;
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
}

/** Serve MCP over newline-delimited JSON-RPC 2.0 on stdin/stdout until stdin closes. */
export async function runMcpServer(opts: {
  tree: CommandNode;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const ctx: RequestContext = {
    tools: buildTools(opts.tree),
    env: opts.env,
    log: createLogger(stderrSink(opts.stderr)),
  };

  const rl = readline.createInterface({input: opts.stdin, crlfDelay: Infinity});
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const response = await handleLine(line, ctx);
    if (response !== undefined) opts.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

async function handleLine(
  line: string,
  ctx: RequestContext
): Promise<unknown> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return errorResponse(null, new JsonRpcError(-32700, 'parse error'));
  }

  const id = request.id ?? null;
  try {
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      throw new JsonRpcError(-32600, 'invalid request');
    }
    const result = await dispatch(request.method, request.params ?? {}, ctx);
    if (result === undefined) return undefined; // notification
    return {jsonrpc: '2.0', id, result};
  } catch (error) {
    if (error instanceof JsonRpcError) return errorResponse(id, error);
    throw error;
  }
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  ctx: RequestContext
): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {tools: {}},
        serverInfo: SERVER_INFO,
      };
    case 'notifications/initialized':
      return undefined;
    case 'tools/list':
      return {tools: ctx.tools.defs};
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') {
        throw new JsonRpcError(-32602, 'invalid params: name is required');
      }
      const command = ctx.tools.byName.get(name);
      if (command === undefined) {
        throw new JsonRpcError(-32602, `unknown tool: ${name}`);
      }
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      return callTool(command, args, {env: ctx.env, log: ctx.log});
    }
    default:
      throw new JsonRpcError(-32601, `method not found: ${method}`);
  }
}

function errorResponse(
  id: string | number | null,
  error: JsonRpcError
): unknown {
  return {jsonrpc: '2.0', id, error: {code: error.code, message: error.message}};
}

/** A logger sink that writes each message as a line to a stream (stderr). */
function stderrSink(stderr: Writable): CoreLogger {
  const write = (message: string) => {
    stderr.write(`${message}\n`);
  };
  const sink = {} as CoreLogger;
  for (const level of LEVELS) sink[level] = write;
  return sink;
}
```

- [ ] **Step 4: Create the barrel `index.mts`**

```ts
export * from './tools.mts';
export * from './dispatch.mts';
export * from './json-rpc-error.mts';
export * from './mcp.mts';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/lib/mcp/mcp.test.mts`
Expected: PASS (all seven cases).

- [ ] **Step 6: Create `lib/mcp/CLAUDE.md`**

```markdown
# MCP

`runMcpServer({tree, stdin, stdout, stderr, env})` in `mcp.mts` serves the
command tree over newline-delimited JSON-RPC 2.0 on stdio — the sibling of
`lib/cli` for the MCP transport. stdout is the protocol channel; diagnostics go
to stderr. `index.mts` is the barrel.

- `tools.mts` — `buildTools(tree)` walks the tree into MCP tool defs (name =
  `_`-joined path, `inputSchema` from `options`) plus a name -> command map,
  skipping commands whose `mcp` transport is off.
- `dispatch.mts` — `callTool` runs one command with a capturing `io` (its output
  is the result text); a `DispatchError` becomes an `isError` result.
- `json-rpc-error.mts` — `JsonRpcError`, thrown by the loop for protocol
  failures (unknown method, malformed request, unknown tool) and rendered into a
  JSON-RPC `error`. Tool failures are `isError` results, not protocol errors.
```

- [ ] **Step 7: Lint, typecheck, full test**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add plugins/dispatch/src/lib/mcp/
git commit -m "feat: serve the command tree over stdio json-rpc"
```

---

## Task 8: The `mcp` command + end-to-end opt-out

Adds the runnable `dispatch mcp` server command (opting out of MCP) and an end-to-end test that the real command tree excludes it from the tool list.

**Files:**
- Create: `plugins/dispatch/src/commands/mcp.mts`
- Modify: `plugins/dispatch/src/main.test.mts` (mcp-exclusion test)

**Interfaces:**
- Consumes: `AbstractCommand`, `discover` from `../lib/command/index.mts`; `runMcpServer` from `../lib/mcp/index.mts`; `buildTools` from `../lib/mcp/index.mts` (test only).
- Produces: `commands/mcp.mts` exporting `Command` (`name = 'mcp'`, `transports = {mcp: false}`).

- [ ] **Step 1: Write the failing test**

Add to `plugins/dispatch/src/main.test.mts` a new test in the existing `describe`:

```ts
  it('discovers the mcp command but excludes it from the generated tools', async () => {
    const {buildTools} = await import('./lib/mcp/index.mts');
    const tree = await discover(COMMANDS);
    assert.ok(tree.children.has('mcp'), 'the mcp command is discovered');
    const {byName} = buildTools(tree);
    assert.ok(!byName.has('mcp'), 'but it opts out of its own transport');
    assert.ok(byName.has('greet'));
  });
```

(`COMMANDS` and `discover` are already imported at the top of `main.test.mts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/dispatch/src/main.test.mts`
Expected: FAIL on `tree.children.has('mcp')` — `commands/mcp.mts` does not exist yet, so the command is not discovered. This is what makes the red→green real: the assertion fails now and passes once the command exists and opts out.

- [ ] **Step 3: Create `commands/mcp.mts`**

```ts
import {AbstractCommand, discover} from '../lib/command/index.mts';
import type {ParsedOptions, CommandContext} from '../lib/command/index.mts';
import {runMcpServer} from '../lib/mcp/index.mts';

const options = {} as const;

export class Command extends AbstractCommand {
  readonly name = 'mcp';
  readonly summary = 'Start the MCP server on stdio.';
  readonly env = [];
  readonly options = options;
  override readonly transports = {mcp: false};

  async run(
    _parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const tree = await discover(new URL('./', import.meta.url));
    await runMcpServer({
      tree,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: ctx.env,
    });
  }
}
```

Note: `new URL('./', import.meta.url)` resolves to the `commands/` directory (this file's own directory), which is what `discover` expects. `discover` is idempotent; re-importing this module during the walk is harmless. `ctx.io`/`ctx.log` go unused — this command's output is the JSON-RPC stream on stdout.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/dispatch/src/main.test.mts`
Expected: PASS — `mcp` is discovered but excluded from tools; `greet` is present.

- [ ] **Step 5: Manually verify the server starts (evidence, not just tests)**

Run: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | ./plugins/dispatch/bin/dispatch mcp`
Expected: one line of JSON on stdout whose `result.tools` array includes `greet` and does not include an `mcp` tool. The process exits when stdin closes.

- [ ] **Step 6: Lint, typecheck, full test**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add plugins/dispatch/src/commands/mcp.mts plugins/dispatch/src/main.test.mts
git commit -m "feat: add the mcp server command"
```

---

## Task 9: Bump plugin version

**Files:**
- Modify: `plugins/dispatch/.claude-plugin/plugin.json` (`version`)

- [ ] **Step 1: Bump the minor version**

Open `plugins/dispatch/.claude-plugin/plugin.json` and increment the `version` field's minor component (new transport = feature). Example: `1.1.0` -> `1.2.0` (use whatever the current value's next minor is).

- [ ] **Step 2: Validate the marketplace**

Run: `claude plugin validate .`
Expected: valid.

- [ ] **Step 3: Commit**

```bash
git add plugins/dispatch/.claude-plugin/plugin.json
git commit -m "chore: bump dispatch version for the mcp transport"
```

---

## Self-Review

**Spec coverage:**

- `io` channel on `CommandContext` → Task 2 (type + wiring), Task 3 (fixtures).
- `transports` field + `resolveTransports` merge → Task 1.
- mcp gating (`buildTools` skips `mcp:false`) → Task 5.
- cli gating (hide + refuse `cli:false`) → Task 4.
- Tool name = `_`-joined path; inputSchema from options (enum/default/required) → Task 5.
- `runMcpServer` JSON-RPC loop, `initialize`/`initialized`/`tools/list`/`tools/call`, `-32601`/`-32700`/`-32600`/`-32602` → Task 7.
- Protocol errors thrown as `JsonRpcError` and rendered centrally; tool failures as `isError` results → Tasks 6 (callTool isError, JsonRpcError) + 7 (throw + render).
- `callTool` stringifies args, reuses `parseOptions`/`assertEnv`, captures `io`, stderr `log` → Task 6.
- `mcp` command starts server + opts out → Task 8.
- Stderr-bound server logger keeps stdout pure → Task 7 (`stderrSink`).
- Version bump → Task 9.

Testing bullets from the spec all map: schema mapping / underscore names / mcp:false excluded / runnable-namespace node (Task 5); callTool output + missing-required + missing-env (Task 6); server initialize+list, tools/call, unknown method, unknown tool, malformed line (Task 7); resolveTransports defaults + cli-gated hidden-and-refused + greet via io (Tasks 1, 4, 2/3).

Not covered by an automated test (documented as a manual step): the runnable-and-namespace node yielding a tool AND its children — `store` + `store_get` both appear in Task 5's name assertions, which does cover it.

**Placeholder scan:** No TBD/TODO. Every code step has full source. The only "use current value" is the version bump (Task 9 Step 1), which is a genuine repo-state read, not a placeholder.

**Type consistency:** `buildTools -> {defs, byName}` used identically in Tasks 5/7/8. `callTool(command, args, {env, log}) -> ToolResult` consistent Tasks 6/7. `JsonRpcError(code, message)` with `.code` consistent Tasks 6/7. `resolveTransports(command) -> {cli, mcp}` consistent Tasks 1/4/5. `Io.write(chunk)` consistent Tasks 2/3/6. `CommandContext {log, env, io}` consistent throughout.
