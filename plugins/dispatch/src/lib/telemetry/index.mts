// Only modules that reach no OpenTelemetry package may be re-exported here.
// This file is what `src/main.mts` loads on every invocation, so an export
// that reaches one would pull the SDK back onto the static import graph and
// undo the fallback `startTelemetry()` exists for. That leaves these two —
// and `stream.mts`, which they import directly and which has to stay free of
// OTel for the same reason. Everything else is imported by path, which is
// what `sdk.mts` and the tests do.
export {flushOnExit} from './exit.mts';
export {startTelemetry} from './telemetry.mts';
export type {Telemetry, TelemetryOptions} from './telemetry.mts';
