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
import type {Telemetry, TelemetryOptions} from './telemetry.mts';

/**
 * How long the whole shutdown gets before the process stops waiting for it.
 *
 * A flush that will not settle — the SDK waits on the resource's asynchronous
 * attributes, and `host.id` is a file read — would otherwise hang a command,
 * and on the signal path it would hold the signal indefinitely.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Every env var that names an OTLP destination.
 *
 * Any one of them means a collector. The per-signal vars are how OTel says to
 * route one signal somewhere else, and a signal left without one falls back to
 * the OTLP default rather than to stderr — that is the behavior the spec
 * describes. Treating only the generic var as "a collector is configured"
 * would send every other signal to stderr and quietly ignore the endpoint
 * that was set.
 */
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

/** Whether a collector has been named, which is the whole exporter decision. */
export function otlpConfigured(env: NodeJS.ProcessEnv): boolean {
  return ENDPOINTS.some((name) => (env[name] ?? '') !== '');
}

/**
 * Whether a signal's selector asks for `console`.
 *
 * `console` is one of the values `NodeSDK` accepts there, and every
 * `Console*Exporter` it builds writes through `console.dir`/`console.log` to
 * stdout. A signal that asks for it gets this module's stream exporter
 * instead: the same readable output, on a stream that is safe to write to.
 */
export function wantsConsole(
  env: NodeJS.ProcessEnv,
  signal: keyof typeof SELECTORS
): boolean {
  return (env[SELECTORS[signal]] ?? '')
    .split(',')
    .some((name) => name.trim() === 'console');
}

/** A processor whose own `shutdown()` does not flush it. See `stopping`. */
interface Flushable {
  forceFlush(): Promise<void>;
}

export interface Pipeline {
  readonly config: Partial<NodeSDKConfiguration>;
  readonly flushables: readonly Flushable[];
}

/**
 * What to hand `NodeSDK`, and what this module has to flush itself.
 *
 * The only variable is where the three signals go. With a collector
 * configured, naming no processor for a signal is what leaves `NodeSDK` to
 * build it from the `OTEL_*` environment — and so what makes
 * `OTEL_EXPORTER_OTLP_PROTOCOL`, the per-signal endpoints, headers, and
 * compression work without this file knowing any of them exist. Naming one
 * turns that handling off for its signal, so the stderr branch names all three
 * and the collector branch names only the signals that asked for `console`.
 */
export function telemetryPipeline(opts: {
  readonly env: NodeJS.ProcessEnv;
  readonly resource: Resource;
  readonly stream: Writable;
}): Pipeline {
  const {env, resource, stream} = opts;

  // Simple, not batched: these lines exist for a human reading stderr, and a
  // batch that has not fired yet is a line that has not appeared. The metric
  // reader is periodic because there is no other way to read an asynchronous
  // instrument; its timer is unref'd, so it cannot hold a short-lived command
  // open.
  const logs = (): SimpleLogRecordProcessor =>
    new SimpleLogRecordProcessor({exporter: stderrLogRecordExporter(stream)});
  const metrics = (): PeriodicExportingMetricReader =>
    new PeriodicExportingMetricReader({exporter: stderrMetricExporter(stream)});
  const traces = (): SimpleSpanProcessor =>
    new SimpleSpanProcessor(stderrSpanExporter(stream));

  if (!otlpConfigured(env)) {
    const onStream = {logs: logs(), metrics: metrics(), traces: traces()};
    return {
      config: {
        logRecordProcessors: [onStream.logs],
        metricReaders: [onStream.metrics],
        resource,
        spanProcessors: [onStream.traces],
      },
      flushables: [onStream.logs, onStream.traces],
    };
  }

  const config: Partial<NodeSDKConfiguration> = {resource};
  const flushables: Flushable[] = [];
  if (wantsConsole(env, 'logs')) {
    const processor = logs();
    config.logRecordProcessors = [processor];
    flushables.push(processor);
  }
  if (wantsConsole(env, 'metrics')) config.metricReaders = [metrics()];
  if (wantsConsole(env, 'traces')) {
    const processor = traces();
    config.spanProcessors = [processor];
    flushables.push(processor);
  }
  return {config, flushables};
}

/**
 * Construct and start the SDK with the environment stdout requires.
 *
 * Two variables have to be kept from `NodeSDK`, and both are read lazily — the
 * selectors in `start()` rather than in the constructor — so the whole startup
 * is bracketed.
 *
 * `OTEL_LOG_LEVEL` makes the constructor install `DiagConsoleLogger`, whose
 * debug, info, and verbose go through `console` to stdout. Replacing that
 * logger afterwards is not enough: registering it emits `Registered a global
 * for diag` at debug level through itself, so the stdout line is already
 * written. The level is not discarded — `startSdk` applies it to the stderr
 * logger instead.
 *
 * `console` in a per-signal selector makes it build a `Console*Exporter`. The
 * signals that asked for one are already served from the stream by
 * `telemetryPipeline`; scrubbing the value here is what keeps a selector this
 * module did not see off stdout too, falling that signal back to the
 * configured collector.
 *
 * `process.env` rather than a threaded bag, because `process.env` is what
 * `NodeSDK` reads.
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
 * `sdk.shutdown()` is not a flush on its own. `SimpleSpanProcessor` and
 * `SimpleLogRecordProcessor` hold a record whose export is waiting on the
 * resource's asynchronous attributes, and their `shutdown()` goes straight to
 * the exporter without awaiting those — only `forceFlush()` does. So a command
 * that finishes before `host.id` resolves loses its records unless the flush
 * is explicit. The batched processors `NodeSDK` builds for a collector do
 * flush on shutdown, which is why only `telemetryPipeline`'s processors are
 * listed.
 *
 * Nothing here may fail or hang. A stream that cannot be written to is no
 * reason to leave the SDK running, and a flush that never settles must not
 * become a command that never exits — or, on the signal path, a signal held
 * forever.
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

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Start the SDK and register it with the OTel API. */
export async function startSdk(opts: TelemetryOptions): Promise<Telemetry> {
  const {stream} = opts;
  const {env} = process;

  // Before the SDK is constructed, so that whatever it says while starting up
  // has somewhere to go. `suppressOverrideMessage` drops the pair of
  // stack-trace warnings `setLogger` otherwise emits about replacing the
  // no-op logger that is there at startup.
  diag.setLogger(stderrDiagLogger(stream), {
    logLevel: diagLogLevelFromString(env.OTEL_LOG_LEVEL) ?? DiagLogLevel.NONE,
    suppressOverrideMessage: true,
  });

  const {config, flushables} = telemetryPipeline({
    env,
    resource: await telemetryResource(),
    stream,
  });
  const sdk = startReservingStdout(config);

  // Memoized because more than one exit path can reach it — a signal, a fatal
  // error, and the `finally` in `src/main.mts` — and the SDK refuses a second
  // shutdown with `Cannot call shutdown twice`.
  let stopped: Promise<void> | undefined;
  return {
    shutdown: (): Promise<void> =>
      (stopped ??= stopping(sdk, flushables, SHUTDOWN_TIMEOUT_MS)),
  };
}
