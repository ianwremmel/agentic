import type {Writable} from 'node:stream';

export interface TelemetryOptions {
  /**
   * Where all three signals go when no collector is configured: stderr.
   *
   * There is deliberately no environment here to go with it. `NodeSDK` reads
   * `process.env` for the endpoints, the protocol, `OTEL_SDK_DISABLED`, and
   * the resource overrides, and cannot be told to read anything else — so an
   * injectable environment could only ever disagree with the one actually in
   * force. The pure predicates in `sdk.mts` take an environment so they can be
   * tested; `startSdk` calls them with `process.env`.
   */
  readonly stream: Writable;
}

export interface Telemetry {
  /**
   * Flush everything buffered and stop exporting.
   *
   * Idempotent, bounded, and the only thing a caller has to remember — the
   * processors hold records until it runs, so without it a short command emits
   * nothing.
   */
  shutdown(): Promise<void>;
}

const INERT: Telemetry = {
  shutdown(): Promise<void> {
    return Promise.resolve();
  },
};

/**
 * Start telemetry, or carry on without it.
 *
 * The OTel packages are reached through a dynamic import so that failing to
 * resolve them costs telemetry and not the CLI. That is not defensive
 * decoration: Claude Code installs a plugin's dependencies only when the
 * version directory it unpacks into holds both a manifest and a lockfile, and
 * it decides whether to re-unpack by comparing version strings — so a release
 * that reuses a number leaves a payload on disk whose `node_modules` was never
 * created. Under a static import every `dispatch` invocation on such an
 * install would fail at load with nothing said about why.
 */
export async function startTelemetry(
  opts: TelemetryOptions
): Promise<Telemetry> {
  try {
    const {startSdk} = await import('./sdk.mts');
    return await startSdk(opts);
  } catch (error) {
    opts.stream.write(`telemetry unavailable: ${String(error)}\n`);
    return INERT;
  }
}
