# Telemetry

`startTelemetry({stream})` in `telemetry.mts` starts the OpenTelemetry SDK and
hands back a `shutdown()`. `src/main.mts` calls it once, before command
discovery, shuts it down in a `finally`, and wraps both in `flushOnExit` for
the exit paths no `finally` sees. Nothing is instrumented yet — spans,
instruments, and log records arrive with the two PRs after this one.

Four constraints shape the files here. Each is a trap rather than a preference,
and each has a test named after it.

**Everything goes to stderr.** `dispatch mcp` serves JSON-RPC on stdout and the
CLI's stdout is the output agents read back. `exporters.mts` implements
`SpanExporter`, `PushMetricExporter`, and `LogRecordExporter` against a stream
because OTel's own `Console*Exporter` classes write through `console` to
stdout, and `diag.mts` exists for the same reason `DiagConsoleLogger` cannot be
used. Two `OTEL_*` values would put the SDK's output back on stdout —
`OTEL_LOG_LEVEL`, and `console` in a per-signal exporter selector — so
`startReservingStdout` in `sdk.mts` keeps both from `NodeSDK` for the length of
startup. Read that docblock before changing the order of anything in it.
`main.test.mts` asserts on the CLI's real stdout, which is the only place the
ordering is visible.

**Only `telemetry.mts` and `exit.mts` may be imported statically.** Everything
else reaches an `@opentelemetry/*` package, and `startTelemetry` loads it
through a dynamic import so that a plugin install whose `node_modules` was
never created loses telemetry rather than every command. That is why
`index.mts` re-exports those two files and nothing else.

**A flush is three separate things, and `sdk.shutdown()` is only one of them.**
The metric reader exports on a timer, and the span and log processors export
each record as it arrives — but not before the resource's asynchronous
attributes resolve, and `host.id` is a file read. Their `shutdown()` goes
straight to the exporter without awaiting the records they are still holding;
only `forceFlush()` waits. So `stop()` force-flushes this module's own
processors first, and the stream exporters' flush waits for the bytes to reach
the OS, because a signal's re-raise does not wait for a pipe.

**Nothing here may throw.** Exporting runs inside the caller's own `emit()` or
`end()`, so a record carrying something `JSON.stringify` refuses would take
down the code being observed — hence `encode.mts`. A failed write emits
`error`, and an unhandled one ends the process — hence `forgiving` in
`stream.mts`. And a flush that never settles would hang the command, so
`shutdown()` is bounded.

The exporter decision is two predicates: `otlpConfigured` and `wantsConsole`,
both in `sdk.mts`. With a collector named and no `console` asked for,
`telemetryPipeline` passes no processors at all, which is what leaves `NodeSDK`
to honor the rest of the `OTEL_*` environment.
