# Telemetry

`startTelemetry({stream})` starts the OTel SDK and returns `shutdown()`.
`src/main.mts` calls it once and shuts it down in a `finally`. Nothing is
instrumented yet.

**Everything goes to stderr.** `dispatch mcp` serves JSON-RPC on stdout and the
CLI's stdout is what agents read back. OTel's `Console*Exporter` and
`DiagConsoleLogger` write to stdout, so `exporters.mts` and `diag.mts` replace
them. `OTEL_LOG_LEVEL` and a `console` exporter selector put the SDK's output
back there, so `startReservingStdout` withholds both from `NodeSDK` during
startup. `main.test.mts` asserts on the CLI's real stdout.

**A signal is named in the config only when it goes to the stream.** Naming one
turns off `NodeSDK`'s whole environment handling for that signal — endpoints,
headers, protocol, `none` — which is why `destinationFor` decides per signal
and why `console` alongside a real exporter loses to it.

**`sdk.shutdown()` is not a flush.** The simple processors can still be holding
a record whose export is waiting on the resource's asynchronous attributes;
only `forceFlush()` waits for those, so `stopping` calls it first. Both it and
`drained` are bounded, so a stream nobody reads costs a timeout, not a hang.

**Nothing here may throw, once started.** Exporting runs inside the caller's
`emit()` or `end()`, hence `encode.mts` and `forgiving` in `stream.mts`.
Failing to start is the opposite: the OTel imports are static, so a broken
install fails the CLI rather than quietly losing telemetry.
