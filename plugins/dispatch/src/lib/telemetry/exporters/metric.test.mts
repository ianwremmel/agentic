import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

import {capture, parseLine} from '../test-support.mts';
import {createMetricExporter} from './metric.mts';

/** A real provider, so a field this exporter reads cannot change shape under it. */
function createMetering(): {
  readLines: () => string[];
  provider: MeterProvider;
} {
  const {readLines, stream} = capture();
  return {
    readLines,
    provider: new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter: createMetricExporter(stream),
        }),
      ],
    }),
  };
}

describe('createMetricExporter', () => {
  it('writes one line per data point, named in the line', async () => {
    const {readLines, provider} = createMetering();

    const counter = provider.getMeter('probe').createCounter('orders', {
      unit: '{order}',
    });
    counter.add(2, {kind: 'dispatch_pr'});
    counter.add(1, {kind: 'dispatch_ticket'});
    await provider.shutdown();

    assert.deepEqual(
      readLines().map((line) => {
        const {fields, signal} = parseLine(line);
        return [
          signal,
          fields.name,
          fields.type,
          fields.unit,
          fields.value,
          fields.attributes,
        ];
      }),
      [
        ['metric', 'orders', 'SUM', '{order}', 2, {kind: 'dispatch_pr'}],
        ['metric', 'orders', 'SUM', '{order}', 1, {kind: 'dispatch_ticket'}],
      ]
    );
  });

  it('omits the unit of an instrument that declares none', async () => {
    const {readLines, provider} = createMetering();

    provider.getMeter('probe').createCounter('claims').add(1);
    await provider.shutdown();

    const [line] = readLines();
    assert.ok(line);
    assert.ok(!('unit' in parseLine(line).fields));
  });
});
