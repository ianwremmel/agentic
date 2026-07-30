# Errors

The failure taxonomy the CLI and MCP server throw. Every deliberate error extends
`DispatchError`, so one `instanceof` separates an intended failure from a crash.
The caller is usually an agent, so errors carry an optional `hint` for whoever has
to fix it. One class per file; `index.mts` re-exports all of them.

`dispatch-error.mts` is the root: `message`, `hint`, `toString()` rendering
message + hint, and no transport-specific field. `command-error.mts` —
`CommandError` extends it for validate/discover/run failures, adding the CLI
`exitCode`; `usage-error.mts` (2), `environment-error.mts` (3), and
`definition-error.mts` (1) specialize it. The MCP server's `JsonRpcError` (in
`lib/mcp`) also extends `DispatchError`, but as a protocol fault it carries a
JSON-RPC `code`, not an `exitCode` — a sibling of `CommandError`, not a command
failure. `ensure.mts` holds `assertUsage` and the lazy `ensure`.

Add a class only when a caller must branch on a failure the existing ones don't
cover; give it its own file under the right parent.
