import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {metrics, trace} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import {emptyResource} from '@opentelemetry/resources';

import {
  otlpConfigured,
  startSdk,
  stopping,
  telemetryPipeline,
  wantsConsole,
} from './sdk.mts';
import {capture, parse} from './test-support.mts';

const ENDPOINTS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
];

const COLLECTOR = {OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318'};

describe('otlpConfigured', () => {
  it('is false with nothing set', () => {
    assert.equal(otlpConfigured({}), false);
  });

  for (const name of ENDPOINTS) {
    it(`is true on ${name} alone`, () => {
      // A per-signal endpoint counts. It is how OTel says to route one signal
      // elsewhere, and the signals without one fall back to the OTLP default
      // — which is the spec's behavior. Reading only the generic variable
      // would send the rest to stderr and ignore the endpoint that was set.
      assert.equal(otlpConfigured({[name]: 'http://collector:4318'}), true);
    });
  }

  it('treats an empty value as unset', () => {
    // Unsetting an inherited variable in a shell or a container spec usually
    // means assigning it nothing, and that has to read as "no collector"
    // rather than as an endpoint of "".
    assert.equal(otlpConfigured({OTEL_EXPORTER_OTLP_ENDPOINT: ''}), false);
  });
});

describe('wantsConsole', () => {
  it('is false with nothing set', () => {
    assert.equal(wantsConsole({}, 'traces'), false);
  });

  it('reads each signal from its own selector', () => {
    const env = {OTEL_LOGS_EXPORTER: 'console'};
    assert.deepEqual(
      (['logs', 'metrics', 'traces'] as const).map((signal) =>
        wantsConsole(env, signal)
      ),
      [true, false, false]
    );
  });

  it('finds console among several exporters', () => {
    assert.equal(
      wantsConsole({OTEL_TRACES_EXPORTER: 'otlp, console'}, 'traces'),
      true
    );
  });

  it('does not match a name that merely contains it', () => {
    assert.equal(
      wantsConsole({OTEL_TRACES_EXPORTER: 'consolefoo'}, 'traces'),
      false
    );
  });
});

describe('telemetryPipeline', () => {
  const resource = emptyResource();

  it('names a processor for all three signals when there is no collector', () => {
    const {stream} = capture();

    const {config} = telemetryPipeline({env: {}, resource, stream});

    assert.equal(config.spanProcessors?.length, 1);
    assert.equal(config.metricReaders?.length, 1);
    assert.equal(config.logRecordProcessors?.length, 1);
  });

  it('names no processor at all when a collector is configured', () => {
    // Naming one turns off NodeSDK's env handling for that signal, which is
    // what makes OTEL_EXPORTER_OTLP_PROTOCOL, the per-signal endpoints,
    // headers, and compression work. Leaving all three unnamed is how those
    // keep working without this module knowing they exist.
    const {stream} = capture();

    const {config} = telemetryPipeline({env: COLLECTOR, resource, stream});

    assert.deepEqual(Object.keys(config), ['resource']);
  });

  it('serves a signal that asked for console from the stream', () => {
    // `console` is a value NodeSDK accepts in these selectors, and every
    // Console*Exporter writes through `console.dir` to stdout — which
    // `dispatch mcp` owns. The signal gets this module's stream exporter
    // instead; the other two still go to the collector.
    const {stream} = capture();

    const {config} = telemetryPipeline({
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

  it('lists the processors whose own shutdown does not flush them', () => {
    // SimpleSpanProcessor and SimpleLogRecordProcessor go straight to the
    // exporter on shutdown without awaiting the exports they are holding, so
    // the flush has to be explicit. The periodic metric reader does collect on
    // shutdown, so it is not listed.
    const {stream} = capture();

    const {flushables} = telemetryPipeline({env: {}, resource, stream});

    assert.equal(flushables.length, 2);
  });
});

describe('stopping', () => {
  it('flushes every processor it owns before the SDK goes down', async () => {
    // `sdk.shutdown()` is not a flush: SimpleSpanProcessor and
    // SimpleLogRecordProcessor go straight to the exporter without awaiting
    // the records they are holding until the resource's asynchronous
    // attributes resolve. Only forceFlush() waits for those, so a command that
    // finishes first loses them.
    const order: string[] = [];
    const flushable = (name: string): {forceFlush: () => Promise<void>} => ({
      forceFlush: async () => {
        await Promise.resolve();
        order.push(name);
      },
    });

    await stopping(
      {
        shutdown: async () => {
          await Promise.resolve();
          order.push('sdk');
        },
      },
      [flushable('logs'), flushable('traces')],
      1_000
    );

    assert.deepEqual(order, ['logs', 'traces', 'sdk']);
  });

  it('stops the SDK even when a flush fails', async () => {
    // A stream that cannot be written to is no reason to leave the SDK running.
    let stopped = false;

    await stopping(
      {
        shutdown: async () => {
          await Promise.resolve();
          stopped = true;
        },
      },
      [{forceFlush: () => Promise.reject(new Error('EPIPE'))}],
      1_000
    );

    assert.equal(stopped, true);
  });

  it('gives up on a flush that never settles', async () => {
    // On the signal path the re-raise waits for this, so an unsettled flush
    // would hold the signal forever. Without the deadline this test hangs.
    await stopping(
      {shutdown: () => new Promise<void>(() => undefined)},
      [{forceFlush: () => new Promise<void>(() => undefined)}],
      10
    );
  });
});

/**
 * One test, because starting the SDK registers the process-wide OTel globals
 * and a second registration is refused rather than applied. `node --test` runs
 * each file in its own process, so this file is the only one that may do it.
 */
describe('startSdk', () => {
  it('puts all three signals on the stream and flushes them on shutdown', async () => {
    const {lines, stream} = capture();

    const telemetry = await startSdk({stream});

    trace.getTracer('probe').startSpan('work').end();
    metrics.getMeter('probe').createCounter('orders').add(1);
    logs.getLogger('probe').emit({body: 'armed', severityText: 'INFO'});

    // Nothing has been written yet, and not only because the metric reader
    // runs on a timer: `hostDetector` resolves `host.id` asynchronously, and
    // the span and log processors hold their records until the resource they
    // carry is complete. So a command short enough to finish first emits all
    // three signals or none, entirely on the flush below.
    assert.deepEqual(lines(), []);

    // Several exit paths reach the shutdown — a signal, a fatal error, and the
    // `finally` in `src/main.mts` — so it has to be one flush rather than
    // several, which the SDK would refuse with `Cannot call shutdown twice`.
    const flush = telemetry.shutdown();
    assert.equal(telemetry.shutdown(), flush);
    await flush;

    assert.deepEqual(
      lines()
        .map((line) => parse(line))
        .map(
          ({fields, signal}) =>
            `${signal} ${String(fields.name ?? fields.severity)}`
        )
        .sort(),
      ['log INFO', 'metric orders', 'span work']
    );
  });
});
