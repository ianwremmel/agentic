# Logger

`createLogger(sink = console)` in `logger.mts` — a metadata-accumulating logger
with a `child(meta)` binder. The docblock there is the contract: merge precedence,
empty-meta handling, and the stderr-bound sink the MCP server must pass so it
never writes to its JSON-RPC channel.

Tests pass a recording sink and assert the `[level, message, meta]` produced,
never the object shape.
