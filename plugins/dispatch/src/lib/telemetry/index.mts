// Only the two modules that import no OpenTelemetry package are re-exported
// here. Everything else in this directory reaches one, and this file is what
// `src/main.mts` loads on every invocation — so an export added here would
// pull the SDK back onto the static import graph and undo the fallback
// `startTelemetry()` exists for. Import those modules by path instead; that is
// what `sdk.mts` and the tests do.
export {flushOnExit} from './exit.mts';
export {startTelemetry} from './telemetry.mts';
export type {Telemetry, TelemetryOptions} from './telemetry.mts';
