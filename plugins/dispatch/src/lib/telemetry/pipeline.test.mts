import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {emptyResource} from '@opentelemetry/resources';

import {buildPipeline} from './pipeline.mts';
import {capture} from './test-support.mts';

const COLLECTOR = {OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318'};

describe('buildPipeline', () => {
  const resource = emptyResource();

  it('names a processor for all three signals when there is no collector', () => {
    const {stream} = capture();

    const {config} = buildPipeline({env: {}, resource, stream});

    assert.equal(config.spanProcessors?.length, 1);
    assert.equal(config.metricReaders?.length, 1);
    assert.equal(config.logRecordProcessors?.length, 1);
  });

  it('names no processor at all when a collector is configured', () => {
    const {stream} = capture();

    const {config} = buildPipeline({env: COLLECTOR, resource, stream});

    assert.deepEqual(Object.keys(config), ['resource']);
  });

  it('serves a signal that asked for console from the stream', () => {
    // The other two still go to the collector.
    const {stream} = capture();

    const {config} = buildPipeline({
      env: {...COLLECTOR, OTEL_TRACES_EXPORTER: 'console'},
      resource,
      stream,
    });

    assert.equal(config.spanProcessors?.length, 1);
    assert.deepEqual(Object.keys(config).sort(), [
      'resource',
      'spanProcessors',
    ]);
  });

  it('names nothing for a signal switched off', () => {
    const {stream} = capture();

    const {config} = buildPipeline({
      env: {OTEL_TRACES_EXPORTER: 'none'},
      resource,
      stream,
    });

    assert.equal(config.spanProcessors, undefined);
    assert.equal(config.logRecordProcessors?.length, 1);
  });

  it('takes the metric reader cadence from the environment', () => {
    const {stream} = capture();

    const {config} = buildPipeline({
      env: {OTEL_METRIC_EXPORT_INTERVAL: '250'},
      resource,
      stream,
    });

    assert.equal(
      (config.metricReaders?.[0] as unknown as {_exportInterval: number})
        ._exportInterval,
      250
    );
  });

  it('lists the processors whose own shutdown does not flush them', () => {
    // The periodic metric reader collects on shutdown, so it is not listed.
    const {stream} = capture();

    const {flushables} = buildPipeline({env: {}, resource, stream});

    assert.equal(flushables.length, 2);
  });
});
