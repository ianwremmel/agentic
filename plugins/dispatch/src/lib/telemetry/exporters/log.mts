import type {Writable} from 'node:stream';

import {SeverityNumber} from '@opentelemetry/api-logs';
import {hrTimeToTimeStamp} from '@opentelemetry/core';
import type {ExportResult} from '@opentelemetry/core';
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from '@opentelemetry/sdk-logs';

import {ignoreWriteErrors} from '../../stream/index.mts';
import {
  createFlushMethods,
  formatEnum,
  OK,
  omitWhenEmpty,
  writeLine,
} from './line.mts';

/**
 * One line per log record on `stream` — bind it to stderr.
 *
 * Not a subclass of `ConsoleLogRecordExporter`: it renders through
 * `_sendLogRecords`, `private` in its public typings, and its
 * `forceFlush`/`shutdown` are no-ops.
 */
export function createLogRecordExporter(stream: Writable): LogRecordExporter {
  const out = ignoreWriteErrors(stream);
  return {
    ...createFlushMethods(out),
    export(
      logs: ReadableLogRecord[],
      resultCallback: (result: ExportResult) => void
    ): void {
      for (const record of logs) {
        writeLine(out, 'log', {
          severity:
            record.severityText ??
            (record.severityNumber === undefined
              ? 'UNSPECIFIED'
              : formatEnum(SeverityNumber, record.severityNumber)),
          time: hrTimeToTimeStamp(record.hrTime),
          body: record.body,
          event: record.eventName,
          trace: record.spanContext?.traceId,
          span: record.spanContext?.spanId,
          attributes: omitWhenEmpty(record.attributes),
          scope: record.instrumentationScope.name,
        });
      }
      resultCallback(OK);
    },
  };
}
