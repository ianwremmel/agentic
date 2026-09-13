import type {Writable} from 'node:stream';

import {SpanKind, SpanStatusCode} from '@opentelemetry/api';
import {hrTimeToMilliseconds, hrTimeToTimeStamp} from '@opentelemetry/core';
import type {ExportResult} from '@opentelemetry/core';
import type {ReadableSpan, SpanExporter} from '@opentelemetry/sdk-trace-base';

import {ignoreWriteErrors} from '../../stream/index.mts';
import {
  createFlushMethods,
  formatEnum,
  OK,
  omitWhenEmpty,
  writeLine,
} from './line.mts';

/**
 * One line per span on `stream` — bind it to stderr.
 *
 * Not a subclass of `ConsoleSpanExporter`: it renders through `_sendSpans`,
 * `private` in its public typings, and its `forceFlush`/`shutdown` are no-ops.
 */
export function createSpanExporter(stream: Writable): SpanExporter {
  const out = ignoreWriteErrors(stream);
  return {
    ...createFlushMethods(out),
    export(
      spans: ReadableSpan[],
      resultCallback: (result: ExportResult) => void
    ): void {
      for (const span of spans) {
        const context = span.spanContext();
        writeLine(out, 'span', {
          name: span.name,
          time: hrTimeToTimeStamp(span.endTime),
          trace: context.traceId,
          span: context.spanId,
          parent: span.parentSpanContext?.spanId,
          kind: formatEnum(SpanKind, span.kind),
          durationMs: hrTimeToMilliseconds(span.duration),
          status:
            span.status.code === SpanStatusCode.UNSET
              ? undefined
              : formatEnum(SpanStatusCode, span.status.code),
          message: span.status.message,
          attributes: omitWhenEmpty(span.attributes),
          // `recordException` is an event, so dropping events drops exceptions.
          events: span.events.length === 0 ? undefined : span.events,
          links: span.links.length === 0 ? undefined : span.links,
          scope: span.instrumentationScope.name,
        });
      }
      resultCallback(OK);
    },
  };
}
