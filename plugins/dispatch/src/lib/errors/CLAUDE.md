# Errors

The failure taxonomy the CLI (and later the MCP server) throws. The caller is
usually an agent, so each error carries an `exitCode` to branch on and an
optional `hint` written for whoever has to fix the failure — name the field,
name the fix.

One class per file; `index.mts` re-exports all of them.

Contract:

- `DispatchError` — base. `exitCode` 1 (a bug; retrying will not help), optional
  `hint`, and a `toString()` that renders the message plus the hint on its own
  line.
- `UsageError` — the caller invoked a command wrong (unknown flag, missing
  required option, value outside `choices`). Exit 2.
- `EnvironmentError` — a variable the command declared in `env` is missing. The
  command was right; the environment was not. Exit 3.
- `DefinitionError` — a command is defined or registered wrong (name ≠ filename,
  missing or non-`AbstractCommand` `Command` export). A plugin bug; exit 1.
- `assertUsage(cond, message)` throws a `UsageError` on a falsy condition.
  `ensure(cond, () => new SomeError(...))` builds the error lazily, so the
  passing path never constructs it — use it when the error needs a hint or
  details.

Add a class only when a caller needs to branch on a failure the existing ones
don't cover; give it its own file and a distinct `exitCode`.
