# Errors

The failure taxonomy the CLI (and later the MCP server) throws. The caller is
usually an agent, so each error carries an `exitCode` to branch on and an optional
`hint` written for whoever has to fix it. One class per file; `index.mts`
re-exports all of them.

`dispatch-error.mts` is the base (exit 1, `toString()` renders message + hint);
`usage-error.mts` (2), `environment-error.mts` (3), and `definition-error.mts`
(1) specialize it — each file's docblock says when it applies. `ensure.mts` holds
`assertUsage` and the lazy `ensure`.

Add a class only when a caller must branch on a failure the existing ones don't
cover; give it its own file and a distinct `exitCode`.
