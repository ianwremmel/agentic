# Logger

`createLogger(sink = console)` in `logger.mts` — a metadata-accumulating logger
with a `child(meta)` binder. The docblock there is the contract: merge precedence
and empty-meta handling.

`streamSink(stream)` in `stream-sink.mts` is the sink every entry point binds to
stderr, because `dispatch mcp` owns stdout as its JSON-RPC channel and `console`
would put `log`/`info`/`debug` there.

Tests pass a recording sink and assert what each call produced — level,
message, metadata, and argument count.
