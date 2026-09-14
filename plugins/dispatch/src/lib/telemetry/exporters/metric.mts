import type {Writable} from 'node:stream';

import {hrTimeToTimeStamp} from '@opentelemetry/core';
import type {ExportResult} from '@opentelemetry/core';
import {DataPointType} from '@opentelemetry/sdk-metrics';
import type {
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

import {ignoreWriteErrors} from '../../stream/index.mts';
import {
  createFlushMethods,
  formatEnum,
  OK,
  omitWhenEmpty,
  writeLine,
} from './line.mts';

/**
 * One line per data point on `stream` — bind it to stderr.
 *
 * Not a subclass of `ConsoleMetricExporter`: its `export()` dispatches to the
 * `private static` `_sendMetrics` by class name, so an override is unreachable at
 * runtime, not merely untyped.
 */
export function createMetricExporter(stream: Writable): PushMetricExporter {
  const out = ignoreWriteErrors(stream);
  return {
    ...createFlushMethods(out),
    export(
      metrics: ResourceMetrics,
      resultCallback: (result: ExportResult) => void
    ): void {
      for (const {scope, metrics: scoped} of metrics.scopeMetrics) {
        for (const metric of scoped) {
          for (const point of metric.dataPoints) {
            writeLine(out, 'metric', {
              name: metric.descriptor.name,
              time: hrTimeToTimeStamp(point.endTime),
              type: formatEnum(DataPointType, metric.dataPointType),
              unit:
                metric.descriptor.unit === ''
                  ? undefined
                  : metric.descriptor.unit,
              value: point.value,
              attributes: omitWhenEmpty(point.attributes),
              scope: scope.name,
            });
          }
        }
      }
      resultCallback(OK);
    },
  };
}
