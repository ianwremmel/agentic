# Dispatch MCP transport

A second transport over the existing command tree. `lib/mcp/` walks the same
`CommandNode` tree that `lib/cli/` drives and exposes each command as an MCP
tool over a hand-rolled stdio JSON-RPC 2.0 server. Commands are available on
both transports by default; a command opts out of either one. The `mcp`
command starts the server and is the first command to opt out of MCP.

This builds directly on the CLI framework (see
`2026-07-28-cli-framework-design.md`), reusing `parseOptions`, `assertEnv`, the
`CommandNode` tree, and the error taxonomy without change.

## What changes in `lib/command`

Two additions to the transport-neutral contract, both consumed by cli and mcp.

### The `io` response channel

Commands currently speak only through `ctx.log`, which conflates diagnostics
with the command's actual answer. That works for the CLI (everything lands on a
stream) but breaks MCP, where diagnostics must go to stderr (off the JSON-RPC
channel) while the answer must become the tool result. So `CommandContext`
gains a third member:

```ts
interface Io {
  /** Response content for the caller. Distinct from `log` (diagnostics). */
  write(chunk: string): void;
}

interface CommandContext {
  readonly log: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly io: Io;
}
```

`log` is diagnostics; `io` is the command's response. Each transport supplies
the concrete `Io`:

- **cli** — `io.write` goes to the injected `stdout` writable.
- **mcp** — `io.write` appends to a per-call buffer that becomes the tool
  result text; the command's `log` binds to a stderr sink so it never touches
  stdout.

`Io` is transport-neutral, so the interface lives in `lib/command`
(`abstract-command.mts`, beside `CommandContext`). `write(chunk)` is the whole
contract for now — the command includes its own newlines; no `writeln` or
structured variant until a command needs one.

### Transport gating

`AbstractCommand` gains one concrete field:

```ts
abstract class AbstractCommand {
  // …existing abstract members…
  readonly transports: {cli?: boolean; mcp?: boolean} = {};
}
```

A command may declare the field partially — the default `{}` means available
everywhere, so existing commands need no edit, and a command opts out of a
single transport without restating the other:

```ts
readonly transports = {mcp: false};   // cli-only, e.g. the `mcp` command
```

Consumers never read the raw partial. `lib/command` exports a resolver that
merges a command's declaration over a fully-populated default, so gating code
always sees a definite boolean and never touches an undefined property:

```ts
function resolveTransports(command: AbstractCommand): {cli: boolean; mcp: boolean} {
  return {cli: true, mcp: true, ...command.transports};
}
```

Gating is enforced at each transport, not in the shared tree, and both branch
on the resolved boolean:

- **mcp** — `buildTools` skips any node where `resolveTransports(command).mcp`
  is `false`.
- **cli** — `runCli` treats a node where `resolveTransports(command).cli` is
  `false` as if it had no runnable command: hidden from subcommand listings and
  usage, and an attempt to invoke it is an unknown-command `UsageError`
  (exit 2).

The cli side is symmetric but currently unused (no command opts out of cli); it
is implemented so the gate means the same thing in both directions.

## `lib/mcp`

`lib/cli` fits in one file; `lib/mcp` carries more surface — JSON-Schema
generation, the JSON-RPC loop, and call dispatch — which exceeds the repo's
~200-line-per-file guideline, so it splits by that rule:

```
src/lib/mcp/
  tools.mts    # buildTools(tree): tree walk -> tool defs + lookup map
  mcp.mts      # runMcpServer(): JSON-RPC loop, request handlers, callTool
  index.mts    # barrel
```

If `mcp.mts` crosses ~200 lines during implementation, `callTool` splits into
its own file then — decided by line count, not upfront.

### Tool generation — `tools.mts`

```ts
interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;   // {type: 'object', properties, required}
}

function buildTools(tree: CommandNode): {
  readonly defs: readonly ToolDef[];
  readonly byName: ReadonlyMap<string, AbstractCommand>;
}
```

Walk the tree the way `discover` built it. For each node with a runnable
`command` where `transports.mcp !== false`, emit one tool:

- **name** — the invocation path segments joined with `_`: `store/get.mts` ->
  `store_get`, a top-level `greet` -> `greet`. Command file and folder names are
  kebab-case (no underscores), so `_` is a collision-free join separator. A node
  that is both runnable and a namespace gets its own tool; its children get
  theirs.
- **description** — the command's `summary`.
- **inputSchema** — a JSON Schema object built from `command.options`. Each
  `Option` becomes one named property (positional vs `--flag` is erased — both
  are named inputs over MCP):
  - `type`: `'string'` | `'number'` | `'boolean'`.
  - `description`: the option's `description`.
  - `choices` -> `enum`.
  - `default` -> the schema `default`.
  - an option is listed in the schema's `required` array iff `required: true`
    (a `boolean` defaults to `false` and a `default` supplies a value, so
    neither is schema-required).

`byName` maps each tool name back to its command for `tools/call`.

### Server and dispatch — `mcp.mts`

```ts
function runMcpServer(opts: {
  tree: CommandNode;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
}): Promise<void>
```

The MCP stdio transport is newline-delimited JSON-RPC 2.0: one JSON object per
line, both directions, on stdin/stdout. `runMcpServer` reads lines with
`node:readline`, parses each as a JSON-RPC request, dispatches by `method`, and
writes one JSON response line per request that has an `id`. Server-lifecycle
diagnostics use a `createLogger` bound to `stderr`, keeping stdout pure
protocol.

Protocol-level failures are not handled inline at each branch. A handler
**throws** a `JsonRpcError` (defined in `lib/errors`, carrying the JSON-RPC `code`
and `message`), and a single `try/catch` around request dispatch renders any
`JsonRpcError` into a proper JSON-RPC `error` response
(`{jsonrpc, id, error: {code, message}}`). This keeps the wire-format
construction in one place instead of scattering error-object literals through
the handlers.

Methods handled:

- `initialize` — respond with the protocol version, `serverInfo`, and
  `capabilities: {tools: {}}`.
- `notifications/initialized` — a notification (no `id`); no response.
- `tools/list` — respond with `buildTools(tree).defs`.
- `tools/call` — look up the tool by `params.name` in `byName`, run it via
  `callTool`, and respond with the result.
- any other method -> throw `JsonRpcError(-32601)` (method not found).

Two distinct failure layers, deliberately not conflated:

- **Protocol errors** (unknown method, a line that is not valid JSON, a request
  missing `jsonrpc`/`method`, an unknown tool name in `tools/call`) throw a
  `JsonRpcError` with the matching code (`-32601` method not found, `-32700`
  parse error, `-32600` invalid request, `-32602` invalid params). The dispatch
  `try/catch` turns each into a JSON-RPC `error` response and the loop continues
  to the next line.
- **Tool execution failures** (a `DispatchError` from running the command) are
  *not* protocol errors — MCP models them as a successful `tools/call` whose
  result carries `isError: true`. `callTool` catches these and returns the
  error result; they never become a JSON-RPC `error`.

The server runs until stdin closes.

`callTool(command, args, {env})` runs a single command:

1. Build the `raw` values map (`Record<string, string | boolean>`) from the
   JSON `args`, stringifying each value so the existing `parseOptions` coercion
   path — written for argv strings — applies unchanged.
2. `parseOptions(command.options, raw)` — coerce, enforce `required`, validate
   `choices`, apply defaults. A violation throws `UsageError`.
3. `assertEnv(command.env, env)` — throws `EnvironmentError` if a declared key
   is missing.
4. Run with a capturing `io` (buffer) and a stderr-bound `log`:
   `command.run(parsed, {log, env, io})`.
5. Return `{content: [{type: 'text', text: buffer}]}`. A thrown `DispatchError`
   is caught and returned as `{isError: true, content: [{type: 'text', text:
   error.toString()}]}` (message + hint); any other throw returns the same with
   `String(error)`. This mirrors how `runCli` maps the same errors to exit
   codes — the transport reports failure in its own shape rather than crashing.

## The `mcp` command

`src/commands/mcp.mts` — the server's entry point and the first command to opt
out of MCP:

```ts
export class Command extends AbstractCommand {
  readonly name = 'mcp';
  readonly summary = 'Start the MCP server on stdio.';
  readonly env = [];
  readonly options = {} as const;
  readonly transports = {mcp: false};

  async run(_parsed, ctx: CommandContext): Promise<void> {
    const tree = await discover(new URL('../commands/', import.meta.url));
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

A server command is inherently process-bound — it owns stdio for the JSON-RPC
channel — so it reaches for `process.stdin`/`stdout`/`stderr` directly, the same
way `main.mts` owns process wiring. It rediscovers the tree from its own
commands directory; `discover` is idempotent, and re-importing the `mcp` module
during that walk is harmless. Its `io` and `log` from `ctx` go unused because
its output is the JSON-RPC stream, not a command response.

`transports = {mcp: false}` keeps the server from listing a tool for itself:
invoking `dispatch mcp` over MCP to spawn a nested server would be nonsense.

## Testing

Behavior tests, one rule each, following the repo's mock-i/o-not-imports rule.

`tools.mts`:

- an option of each type maps to the right JSON-Schema property (`enum` from
  `choices`, `default` carried, `required` array holds only `required: true`
  options);
- the tree walk names tools by `_`-joined path and emits one per runnable node;
- a node with `transports.mcp === false` produces no tool;
- a node that is both runnable and a namespace yields a tool and so do its
  children.

`mcp.mts`:

- feeding `initialize` then `tools/list` over in-memory streams returns the
  generated tool list;
- `tools/call` for a known tool runs the command and returns its captured `io`
  output as text;
- a command whose required option is missing / whose value is outside `choices`
  returns `isError: true` with the hint, not a crash;
- a command with a missing declared `env` var returns `isError: true`;
- an unknown method throws `JsonRpcError(-32601)`, rendered as a JSON-RPC
  `error` response;
- an unknown tool name in `tools/call` returns a JSON-RPC `error` (invalid
  params), not an `isError` result;
- a malformed (non-JSON) input line returns a JSON-RPC parse `error` and the
  loop survives to process the next line.

`lib/command` / `lib/cli`:

- `resolveTransports` fills defaults: a command declaring nothing resolves to
  `{cli: true, mcp: true}`, and one declaring `{mcp: false}` resolves to
  `{cli: true, mcp: false}` (the unstated side stays `true`);
- a fixture command that opts out of cli is hidden from cli subcommand listing
  and exits 2 when invoked;
- the greet command emits its greeting through `io` (its E2E assertion moves
  from the recording logger to captured `io`/stdout output).
