# Logger

`createLogger(sink = console)` wraps a console-shaped `CoreLogger` in a `Proxy`
that forwards the six level methods and adds `child(meta)`.

Contract:

- Methods are `(message, meta?)` — stricter than `Console` but `console` still
  satisfies `CoreLogger`, so it is the zero-adapter default sink.
- Bound metadata wins over a colliding call-site key; a deeper `child()` wins
  over a shallower one.
- Empty merged metadata means the sink is called with the message alone (no
  stray `{}`).
- The default `console` sends `info`/`debug`/`log` to **stdout**. The MCP server
  speaks JSON-RPC on stdout, so it must construct the logger with a
  stderr-bound sink.

Tests pass a recording sink and assert the `[level, message, meta]` the logger
produces — never the shape of the object.
