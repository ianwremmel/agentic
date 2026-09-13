# Telemetry

`startTelemetry({stream})` starts the OTel SDK and returns `shutdown()`.
`src/main.mts` calls it once and shuts it down in a `finally`. Nothing is
instrumented yet.

`destination.mts` routes each signal, `pipeline.mts` turns that into `NodeSDK`
config, `telemetry.mts` starts and stops the SDK, `exporters/` writes one line
per record. `encode` and `drain` come from `lib/encode` and `lib/stream`.

**Nothing goes to stdout.** `dispatch mcp` serves JSON-RPC there and the CLI's
stdout is what agents read back, so this module's own output goes to stderr and a
configured collector keeps its own destination. OTel's `Console*Exporter` and
`DiagConsoleLogger` write to stdout, so `exporters/` replaces them, and
`startReservingStdout` withholds `OTEL_LOG_LEVEL` and any `console` selector from
`NodeSDK` during startup. `main.test.mts` asserts on the CLI's real stdout.

**A signal is named in the config only when it goes to the stream.** Naming one
turns off `NodeSDK`'s whole environment handling for that signal — endpoints,
headers, protocol, `none` — which is why `resolveDestination` decides per signal
and why `console` alongside a real exporter loses to it.

**The simple processors need `forceFlush()` before `sdk.shutdown()`.** They can
still be holding a record whose export is waiting on the resource's asynchronous
attributes, and only `forceFlush()` waits for those, so `flushAndStop` calls it
first. It and `drain` are both bounded, so a stream nobody reads costs a timeout,
not a hang. The batched processors `NodeSDK` builds for a collector do flush
themselves.

**Nothing here may throw, once started.** Exporting runs inside the caller's
`emit()` or `end()`, hence `encode` and `ignoreWriteErrors`. Failing to start is
the opposite: the OTel imports are static, so a broken install fails the CLI
rather than quietly losing telemetry.
