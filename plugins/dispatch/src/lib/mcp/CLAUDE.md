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

The loop throws `JsonRpcError` (in `lib/errors`) for protocol failures (unknown
method, malformed request, unknown tool) and renders it into a JSON-RPC `error`.
Tool failures are `isError` results, not protocol errors.
