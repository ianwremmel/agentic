import type {Writable} from 'node:stream';

import type {Resource} from '@opentelemetry/resources';
import {SimpleLogRecordProcessor} from '@opentelemetry/sdk-logs';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import type {NodeSDKConfiguration} from '@opentelemetry/sdk-node';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';

import {resolveDestination} from './destination.mts';
import {createLogRecordExporter} from './exporters/log.mts';
import {createMetricExporter} from './exporters/metric.mts';
import {createSpanExporter} from './exporters/span.mts';

/** A processor that needs `forceFlush()` before shutdown. See `flushAndStop`. */
export interface Flushable {
  forceFlush(): Promise<void>;
}

export interface Pipeline {
  readonly config: Partial<NodeSDKConfiguration>;
  readonly flushables: readonly Flushable[];
}

/** A positive, finite number of milliseconds from the environment, or `undefined`. */
function parseMillis(value: string | undefined): number | undefined {
  const parsed = Number(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * What to hand `NodeSDK`, and what the caller has to flush itself.
 *
 * A signal is named here only when it goes to the stream. Leaving one unnamed is
 * what keeps `NodeSDK`'s environment handling — protocol, per-signal endpoints,
 * headers, compression, `none` — working for it.
 */
export function buildPipeline(opts: {
  readonly env: NodeJS.ProcessEnv;
  readonly resource: Resource;
  readonly stream: Writable;
}): Pipeline {
  const {env, resource, stream} = opts;

  const config: Partial<NodeSDKConfiguration> = {resource};
  const flushables: Flushable[] = [];

  // Simple, not batched: an unfired batch is a line not yet on stderr.
  if (resolveDestination(env, 'logs') === 'stream') {
    const processor = new SimpleLogRecordProcessor({
      exporter: createLogRecordExporter(stream),
    });
    config.logRecordProcessors = [processor];
    flushables.push(processor);
  }
  if (resolveDestination(env, 'traces') === 'stream') {
    const processor = new SimpleSpanProcessor(createSpanExporter(stream));
    config.spanProcessors = [processor];
    flushables.push(processor);
  }

  // Periodic because an asynchronous instrument cannot be read any other way.
  // This constructor, unlike the SDK's own, does not read the cadence from the
  // environment, so moving metrics to stderr would otherwise reset it to 60s.
  if (resolveDestination(env, 'metrics') === 'stream') {
    const interval = parseMillis(env.OTEL_METRIC_EXPORT_INTERVAL);
    const timeout = parseMillis(env.OTEL_METRIC_EXPORT_TIMEOUT);
    config.metricReaders = [
      new PeriodicExportingMetricReader({
        exporter: createMetricExporter(stream),
        ...(interval === undefined ? {} : {exportIntervalMillis: interval}),
        ...(timeout === undefined ? {} : {exportTimeoutMillis: timeout}),
      }),
    ];
  }

  return {config, flushables};
}
