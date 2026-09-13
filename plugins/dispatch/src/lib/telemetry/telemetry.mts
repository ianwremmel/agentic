import type {Writable} from 'node:stream';

import {diag, DiagLogLevel} from '@opentelemetry/api';
import {diagLogLevelFromString} from '@opentelemetry/core';
import type {Resource} from '@opentelemetry/resources';
import {SimpleLogRecordProcessor} from '@opentelemetry/sdk-logs';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import {NodeSDK} from '@opentelemetry/sdk-node';
import type {NodeSDKConfiguration} from '@opentelemetry/sdk-node';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';

import {stderrDiagLogger} from './diag.mts';
import {
  stderrLogRecordExporter,
  stderrMetricExporter,
  stderrSpanExporter,
} from './exporters.mts';
import {telemetryResource} from './resource.mts';

/** Bound so a flush that never settles cannot become a command that never exits. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Any of these means a collector, per the OTLP exporter spec. */
const ENDPOINTS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

/** The per-signal exporter selectors `NodeSDK` reads from the environment. */
const SELECTORS = {
  logs: 'OTEL_LOGS_EXPORTER',
  metrics: 'OTEL_METRICS_EXPORTER',
  traces: 'OTEL_TRACES_EXPORTER',
} as const;

export interface TelemetryOptions {
  /** Where the signals go with no collector configured: stderr. */
  readonly stream: Writable;
}

export interface Telemetry {
  /** Flush and stop. Idempotent and bounded; without it a short command emits nothing. */
  shutdown(): Promise<void>;
}

/** Whether a collector has been named. Trimmed, because the SDK's own env reader trims. */
export function otlpConfigured(env: NodeJS.ProcessEnv): boolean {
  return ENDPOINTS.some((name) => (env[name] ?? '').trim() !== '');
}

/**
 * Where one signal's records go.
 *
 * `stream` is this module's stderr exporter, `sdk` leaves `NodeSDK` to build
 * the exporter from the environment, and `off` names nothing so the SDK's own
 * handling of `none` applies.
 */
export type Destination = 'off' | 'sdk' | 'stream';

/** Read one signal's exporter selector, lowercased and trimmed. */
function selected(
  env: NodeJS.ProcessEnv,
  signal: keyof typeof SELECTORS
): string[] {
  return (env[SELECTORS[signal]] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
}

/**
 * Route one signal.
 *
 * An unset selector is the common case: stderr when no collector is named,
 * otherwise the collector. `none` disables the signal outright.
 *
 * `console` asks for output a human reads, which OTel would put on stdout, so
 * this module serves it from stderr instead. It can only do that by naming a
 * processor, and naming one turns off `NodeSDK`'s environment handling for the
 * whole signal — so a selector that pairs `console` with a real exporter
 * cannot have both. The real exporter wins and `startTelemetry` warns, because
 * silently dropping a collector is worse than dropping a debugging aid.
 */
export function destinationFor(
  env: NodeJS.ProcessEnv,
  signal: keyof typeof SELECTORS
): Destination {
  const names = selected(env, signal);
  if (names.length === 0) return otlpConfigured(env) ? 'sdk' : 'stream';
  if (names.every((name) => name === 'none')) return 'off';
  if (!names.includes('console')) return 'sdk';
  return names.every((name) => name === 'console' || name === 'none')
    ? 'stream'
    : 'sdk';
}

/** A processor whose own `shutdown()` does not flush it. See `stopping`. */
interface Flushable {
  forceFlush(): Promise<void>;
}

export interface Pipeline {
  readonly config: Partial<NodeSDKConfiguration>;
  readonly flushables: readonly Flushable[];
}

/** A positive integer of milliseconds from the environment, or `undefined`. */
function millis(value: string | undefined): number | undefined {
  const parsed = Number(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * What to hand `NodeSDK`, and what this module has to flush itself.
 *
 * A signal is named here only when it goes to the stream. Leaving one unnamed
 * is what keeps `NodeSDK`'s environment handling — the protocol, per-signal
 * endpoints, headers, compression, and `none` — working for it.
 */
export function telemetryPipeline(opts: {
  readonly env: NodeJS.ProcessEnv;
  readonly resource: Resource;
  readonly stream: Writable;
}): Pipeline {
  const {env, resource, stream} = opts;

  const config: Partial<NodeSDKConfiguration> = {resource};
  const flushables: Flushable[] = [];

  // Simple, not batched: a batch that has not fired yet is a line that has not
  // appeared on the stderr a human is reading.
  if (destinationFor(env, 'logs') === 'stream') {
    const processor = new SimpleLogRecordProcessor({
      exporter: stderrLogRecordExporter(stream),
    });
    config.logRecordProcessors = [processor];
    flushables.push(processor);
  }
  if (destinationFor(env, 'traces') === 'stream') {
    const processor = new SimpleSpanProcessor(stderrSpanExporter(stream));
    config.spanProcessors = [processor];
    flushables.push(processor);
  }

  // Periodic because there is no other way to read an asynchronous instrument.
  // The interval and timeout come from the environment because this
  // constructor, unlike the SDK's own, does not read it — otherwise moving a
  // signal to stderr would silently change its cadence as well as its
  // destination.
  if (destinationFor(env, 'metrics') === 'stream') {
    const interval = millis(env.OTEL_METRIC_EXPORT_INTERVAL);
    const timeout = millis(env.OTEL_METRIC_EXPORT_TIMEOUT);
    config.metricReaders = [
      new PeriodicExportingMetricReader({
        exporter: stderrMetricExporter(stream),
        ...(interval === undefined ? {} : {exportIntervalMillis: interval}),
        ...(timeout === undefined ? {} : {exportTimeoutMillis: timeout}),
      }),
    ];
  }

  return {config, flushables};
}

/**
 * Construct and start the SDK with two env vars withheld, both of which put
 * its output on stdout.
 *
 * `OTEL_LOG_LEVEL` makes the constructor install `DiagConsoleLogger`.
 * Replacing that logger afterwards is too late: registering it emits
 * `Registered a global for diag` at debug level through itself. `startTelemetry`
 * applies the level to the stderr logger instead.
 *
 * `console` in a per-signal selector makes it build a `Console*Exporter`.
 * `telemetryPipeline` already serves those signals from the stream; scrubbing
 * the value keeps a selector this module did not see off stdout too.
 *
 * Both are read lazily, in `start()` rather than the constructor, so the whole
 * startup is bracketed.
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
 * `sdk.shutdown()` is not a flush on its own: the simple processors hold a
 * record whose export is waiting on the resource's asynchronous attributes,
 * and their `shutdown()` goes to the exporter without awaiting those. Only
 * `forceFlush()` does. The batched processors `NodeSDK` builds for a collector
 * do flush on shutdown, which is why only `telemetryPipeline`'s are listed.
 */
export async function stopping(
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

  // Not unref'd. `src/main.mts` awaits this at the top level, and an unref'd
  // timer is not a handle that keeps the loop alive — so a flush that never
  // settles would let Node exit 13 on the unsettled await instead of taking
  // this deadline. It is cleared either way in the `finally`.
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
  diag.setLogger(stderrDiagLogger(stream), {
    logLevel: diagLogLevelFromString(env.OTEL_LOG_LEVEL) ?? DiagLogLevel.NONE,
    suppressOverrideMessage: true,
  });

  // `destinationFor` resolves this pairing in favor of the real exporter, but
  // silently would leave someone waiting on console output that never comes.
  for (const signal of ['logs', 'metrics', 'traces'] as const) {
    const names = (env[SELECTORS[signal]] ?? '')
      .split(',')
      .map((s) => s.trim());
    if (names.includes('console') && names.some((s) => s !== 'console')) {
      diag.warn(
        `${SELECTORS[signal]} lists console alongside another exporter; ` +
          'console is dropped, because serving it from stderr would replace ' +
          'the others entirely.'
      );
    }
  }

  const {config, flushables} = telemetryPipeline({
    env,
    resource: await telemetryResource(),
    stream,
  });
  const sdk = startReservingStdout(config);

  // Memoized: more than one exit path reaches it, and the SDK refuses a second
  // shutdown with `Cannot call shutdown twice`.
  let stopped: Promise<void> | undefined;
  return {
    shutdown: (): Promise<void> =>
      (stopped ??= stopping(sdk, flushables, SHUTDOWN_TIMEOUT_MS)),
  };
}
