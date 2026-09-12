/**
 * Exporters that render each signal as one line on a stream — bind them to
 * stderr.
 *
 * OTel ships `ConsoleSpanExporter`, `ConsoleMetricExporter`, and
 * `ConsoleLogRecordExporter`, and none of them can be used here: they write
 * through `console.log`/`console.dir`, which go to stdout. `dispatch mcp` owns
 * stdout as its JSON-RPC channel and the CLI's stdout is the command output
 * agents read, so one line in either stream is a parse error for whatever is
 * reading it.
 *
 * A line is a signal name and one JSON object: `span {"name":"…",…}`. The name
 * goes inside the object rather than into the prefix because a span name is
 * arbitrary text — one containing a newline would otherwise split the record
 * across two lines, and one containing the delimiter would make it ambiguous.
 * `name` is written first so it is still the first thing read.
 */
import type {Writable} from 'node:stream';

import {SpanKind, SpanStatusCode} from '@opentelemetry/api';
import {SeverityNumber} from '@opentelemetry/api-logs';
import {
  ExportResultCode,
  hrTimeToMilliseconds,
  hrTimeToTimeStamp,
} from '@opentelemetry/core';
import type {ExportResult} from '@opentelemetry/core';
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import {DataPointType} from '@opentelemetry/sdk-metrics';
import type {
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import type {ReadableSpan, SpanExporter} from '@opentelemetry/sdk-trace-base';

import {encode} from './encode.mts';
import {drained, forgiving} from './stream.mts';

/** Reverse-map a numeric OTel enum, falling back to the raw value. */
function named(
  table: Record<number, string | undefined>,
  value: number
): string {
  return table[value] ?? String(value);
}

/** Drop an attribute bag that has nothing in it, so the line stays short. */
function present<T extends object>(attributes: T): T | undefined {
  return Object.keys(attributes).length === 0 ? undefined : attributes;
}

/** One record, one line. Fields set to `undefined` are omitted. */
function line(
  stream: Writable,
  signal: string,
  fields: Record<string, unknown>
): void {
  stream.write(`${signal} ${encode(fields)}\n`);
}

const OK: ExportResult = {code: ExportResultCode.SUCCESS};

/**
 * The flush and shutdown half of all three exporters.
 *
 * Nothing reports a failed write, because a stream that cannot be written to
 * has no second channel to complain on and telling the SDK the export failed
 * only buys a retry into the same stream. What both calls do owe the caller is
 * waiting for the bytes: `shutdown()` is the last thing that runs before a
 * signalled process is killed.
 */
function flushing(stream: Writable): {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
} {
  return {
    forceFlush: (): Promise<void> => drained(stream),
    shutdown: (): Promise<void> => drained(stream),
  };
}

export function stderrSpanExporter(stream: Writable): SpanExporter {
  const out = forgiving(stream);
  return {
    ...flushing(out),
    export(
      spans: ReadableSpan[],
      resultCallback: (result: ExportResult) => void
    ): void {
      for (const span of spans) {
        const context = span.spanContext();
        line(out, 'span', {
          name: span.name,
          time: hrTimeToTimeStamp(span.endTime),
          trace: context.traceId,
          span: context.spanId,
          parent: span.parentSpanContext?.spanId,
          kind: named(SpanKind, span.kind),
          durationMs: hrTimeToMilliseconds(span.duration),
          status:
            span.status.code === SpanStatusCode.UNSET
              ? undefined
              : named(SpanStatusCode, span.status.code),
          message: span.status.message,
          attributes: present(span.attributes),
          scope: span.instrumentationScope.name,
        });
      }
      resultCallback(OK);
    },
  };
}

export function stderrMetricExporter(stream: Writable): PushMetricExporter {
  const out = forgiving(stream);
  return {
    ...flushing(out),
    export(
      metrics: ResourceMetrics,
      resultCallback: (result: ExportResult) => void
    ): void {
      for (const {scope, metrics: scoped} of metrics.scopeMetrics) {
        for (const metric of scoped) {
          for (const point of metric.dataPoints) {
            line(out, 'metric', {
              name: metric.descriptor.name,
              time: hrTimeToTimeStamp(point.endTime),
              type: named(DataPointType, metric.dataPointType),
              unit:
                metric.descriptor.unit === ''
                  ? undefined
                  : metric.descriptor.unit,
              value: point.value,
              attributes: present(point.attributes),
              scope: scope.name,
            });
          }
        }
      }
      resultCallback(OK);
    },
  };
}

export function stderrLogRecordExporter(stream: Writable): LogRecordExporter {
  const out = forgiving(stream);
  return {
    ...flushing(out),
    export(
      logs: ReadableLogRecord[],
      resultCallback: (result: ExportResult) => void
    ): void {
      for (const record of logs) {
        line(out, 'log', {
          severity:
            record.severityText ??
            (record.severityNumber === undefined
              ? 'UNSPECIFIED'
              : named(SeverityNumber, record.severityNumber)),
          time: hrTimeToTimeStamp(record.hrTime),
          body: record.body,
          event: record.eventName,
          trace: record.spanContext?.traceId,
          span: record.spanContext?.spanId,
          attributes: present(record.attributes),
          scope: record.instrumentationScope.name,
        });
      }
      resultCallback(OK);
    },
  };
}
