import type {Writable} from 'node:stream';

import {diag, DiagLogLevel} from '@opentelemetry/api';
import {diagLogLevelFromString} from '@opentelemetry/core';
import {NodeSDK} from '@opentelemetry/sdk-node';
import type {NodeSDKConfiguration} from '@opentelemetry/sdk-node';

import {SELECTORS, warnOnConsolePairing} from './destination.mts';
import {createDiagLogger} from './exporters/diag.mts';
import {buildPipeline} from './pipeline.mts';
import type {Flushable} from './pipeline.mts';
import {buildResource} from './resource.mts';

/** Bound so a flush that never settles cannot become a command that never exits. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface TelemetryOptions {
  /** Where the signals go with no collector configured: stderr. */
  readonly stream: Writable;
}

export interface Telemetry {
  /** Flush and stop. Idempotent and bounded; without it a short command emits nothing. */
  shutdown(): Promise<void>;
}

/**
 * Construct and start the SDK with the two settings that would put its output on
 * stdout withheld. Both the constructor and `start()` are inside the bracket,
 * because `NodeSDK` reads `OTEL_LOG_LEVEL` in the constructor.
 *
 * `OTEL_LOG_LEVEL` makes it install `DiagConsoleLogger`, and replacing that
 * logger afterwards is too late: registering it emits `Registered a global for
 * diag` through itself. `startTelemetry` applies the level to the stderr logger
 * instead.
 *
 * `console` in a per-signal selector makes it build a `Console*Exporter`.
 * `buildPipeline` already serves those signals from the stream; scrubbing the
 * value keeps a selector this module did not see off stdout too.
 */
function startReservingStdout(config: Partial<NodeSDKConfiguration>): NodeSDK {
  const saved = new Map<string, string | undefined>();
  const hide = (name: string, replacement: string | undefined): void => {
    saved.set(name, process.env[name]);
    if (replacement === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = replacement;
  };

  if (process.env.OTEL_LOG_LEVEL !== undefined) {
    hide('OTEL_LOG_LEVEL', undefined);
  }
  for (const name of Object.values(SELECTORS)) {
    const value = process.env[name];
    if (value === undefined) continue;
    const listed = value.split(',');
    const kept = listed.filter((one) => one.trim() !== 'console');
    if (kept.length !== listed.length) {
      hide(name, kept.length === 0 ? undefined : kept.join(','));
    }
  }

  try {
    const sdk = new NodeSDK(config);
    sdk.start();
    return sdk;
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

/**
 * Flush what this module owns, then stop the SDK, and give up after `ms`.
 *
 * `sdk.shutdown()` is not a flush for the simple processors: they hold a record
 * whose export is waiting on the resource's asynchronous attributes, and only
 * `forceFlush()` awaits those. The batched processors `NodeSDK` builds for a
 * collector do flush on shutdown, which is why only `buildPipeline`'s are listed.
 */
export async function flushAndStop(
  sdk: {shutdown(): Promise<void>},
  flushables: readonly Flushable[],
  ms: number
): Promise<void> {
  const work = (async (): Promise<void> => {
    await Promise.all(
      flushables.map(async (one) => one.forceFlush().catch(() => undefined))
    );
    await sdk.shutdown().catch(() => undefined);
  })();

  // Referenced, not unref'd: `src/main.mts` awaits this from a top-level await,
  // where an unref'd timer would let Node exit 13 on the unsettled await instead
  // of taking this deadline.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Start the SDK and register it with the OTel API. */
export async function startTelemetry(
  opts: TelemetryOptions
): Promise<Telemetry> {
  const {stream} = opts;
  const {env} = process;

  // Before the SDK is constructed, so its startup output has somewhere to go.
  // `suppressOverrideMessage` drops the stack-trace warnings `setLogger`
  // otherwise emits about replacing the startup no-op logger.
  diag.setLogger(createDiagLogger(stream), {
    logLevel: diagLogLevelFromString(env.OTEL_LOG_LEVEL) ?? DiagLogLevel.NONE,
    suppressOverrideMessage: true,
  });
  warnOnConsolePairing(env);

  const {config, flushables} = buildPipeline({
    env,
    resource: await buildResource(),
    stream,
  });
  const sdk = startReservingStdout(config);

  // Memoized: more than one exit path reaches it, and the SDK refuses a second
  // shutdown with `Cannot call shutdown twice`.
  let stopped: Promise<void> | undefined;
  return {
    shutdown: (): Promise<void> =>
      (stopped ??= flushAndStop(sdk, flushables, SHUTDOWN_TIMEOUT_MS)),
  };
}
