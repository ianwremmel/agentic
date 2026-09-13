import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {describe, it} from 'node:test';
import {promisify} from 'node:util';

import {metrics, trace} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import {emptyResource} from '@opentelemetry/resources';

import {capture, childEnv, parse, withoutOtelEnv} from './test-support.mts';
import {
  destinationFor,
  otlpConfigured,
  startTelemetry,
  stopping,
  telemetryPipeline,
} from './telemetry.mts';

const execFileAsync = promisify(execFile);

const INDEX = new URL('./index.mts', import.meta.url).href;

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
      // A per-signal endpoint counts: the signals without one fall back to the
      // OTLP default, per spec. Reading only the generic variable would send
      // the rest to stderr and ignore the endpoint that was set.
      assert.equal(otlpConfigured({[name]: 'http://collector:4318'}), true);
    });
  }

  it('treats an empty value as unset', () => {
    // Unsetting an inherited variable in a shell or container spec means
    // assigning it nothing, which has to read as "no collector".
    assert.equal(otlpConfigured({OTEL_EXPORTER_OTLP_ENDPOINT: ''}), false);
  });

  it('treats a whitespace-only value as unset', () => {
    // The SDK's own environment reader trims before testing for empty, so
    // without this the module hands a signal to an endpoint the SDK will not
    // use, and stderr never sees it.
    assert.equal(otlpConfigured({OTEL_EXPORTER_OTLP_ENDPOINT: '  '}), false);
  });
});

describe('destinationFor', () => {
  it('goes to the stream with no collector and no selector', () => {
    assert.equal(destinationFor({}, 'traces'), 'stream');
  });

  it('goes to the SDK with a collector and no selector', () => {
    assert.equal(destinationFor(COLLECTOR, 'traces'), 'sdk');
  });

  it('turns a signal off when its selector says none', () => {
    // `none` is how the spec disables one signal. Naming a stderr processor
    // for it anyway would export telemetry that was explicitly switched off.
    assert.equal(
      destinationFor({OTEL_TRACES_EXPORTER: 'none'}, 'traces'),
      'off'
    );
  });

  it('serves console from the stream even with a collector configured', () => {
    assert.equal(
      destinationFor({...COLLECTOR, OTEL_TRACES_EXPORTER: 'console'}, 'traces'),
      'stream'
    );
  });

  it('keeps the real exporter when a selector pairs it with console', () => {
    // Serving console means naming the processor, which turns off NodeSDK's
    // environment handling for the whole signal — so `otlp,console` served
    // from the stream would silently drop the collector.
    assert.equal(
      destinationFor(
        {...COLLECTOR, OTEL_TRACES_EXPORTER: 'otlp,console'},
        'traces'
      ),
      'sdk'
    );
  });

  it('reads each signal from its own selector', () => {
    const env = {OTEL_LOGS_EXPORTER: 'none'};
    assert.deepEqual(
      (['logs', 'metrics', 'traces'] as const).map((signal) =>
        destinationFor(env, signal)
      ),
      ['off', 'stream', 'stream']
    );
  });

  it('does not match a name that merely contains console', () => {
    assert.equal(
      destinationFor({OTEL_TRACES_EXPORTER: 'consolefoo'}, 'traces'),
      'sdk'
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
    // Naming one turns off NodeSDK's env handling for that signal. Leaving all
    // three unnamed is what makes OTEL_EXPORTER_OTLP_PROTOCOL, the per-signal
    // endpoints, headers, and compression work without this module knowing
    // they exist.
    const {stream} = capture();

    const {config} = telemetryPipeline({env: COLLECTOR, resource, stream});

    assert.deepEqual(Object.keys(config), ['resource']);
  });

  it('serves a signal that asked for console from the stream', () => {
    // Every Console*Exporter NodeSDK builds for that selector writes through
    // `console.dir` to stdout, which `dispatch mcp` owns. The signal gets the
    // stream exporter; the other two still go to the collector.
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

  it('names nothing for a signal switched off', () => {
    const {stream} = capture();

    const {config} = telemetryPipeline({
      env: {OTEL_TRACES_EXPORTER: 'none'},
      resource,
      stream,
    });

    assert.equal(config.spanProcessors, undefined);
    assert.equal(config.logRecordProcessors?.length, 1);
  });

  it('takes the metric reader cadence from the environment', () => {
    // `PeriodicExportingMetricReader`, unlike the SDK's own construction of
    // it, does not read these — so without this, moving metrics to stderr
    // silently resets the interval to the 60s default.
    const {stream} = capture();

    const {config} = telemetryPipeline({
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
    // The two simple processors go straight to the exporter on shutdown
    // without awaiting what they hold. The periodic metric reader does collect
    // on shutdown, so it is not listed.
    const {stream} = capture();

    const {flushables} = telemetryPipeline({env: {}, resource, stream});

    assert.equal(flushables.length, 2);
  });
});

describe('stopping', () => {
  it('flushes every processor it owns before the SDK goes down', async () => {
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
    // Without the deadline this test hangs, which is what a command whose
    // flush never settles would do.
    await stopping(
      {shutdown: () => new Promise<void>(() => undefined)},
      [{forceFlush: () => new Promise<void>(() => undefined)}],
      10
    );
  });
});

/**
 * Starting the SDK registers the process-wide OTel globals and a second
 * registration is refused, so the in-process case gets exactly one test. The
 * subprocess tests below each get their own process.
 */
describe('startTelemetry', () => {
  it('puts all three signals on the stream and flushes them on shutdown', async () => {
    // `withoutOtelEnv` because `startTelemetry` reads `process.env` — the only
    // environment NodeSDK reads. A host OTEL_LOG_LEVEL would add diag lines to
    // the stream under assertion and a host endpoint would switch the branch.
    await withoutOtelEnv(async () => {
      const {lines, stream} = capture();

      const telemetry = await startTelemetry({stream});

      trace.getTracer('probe').startSpan('work').end();
      metrics.getMeter('probe').createCounter('orders').add(1);
      logs.getLogger('probe').emit({body: 'armed', severityText: 'INFO'});

      // Nothing is written yet, and not only because the metric reader runs on
      // a timer: `hostDetector` resolves `host.id` asynchronously and the span
      // and log processors hold their records until the resource is complete.
      // A command short enough to finish first emits all three or none.
      assert.deepEqual(lines(), []);

      // Several exit paths reach the shutdown, so it has to be one flush
      // rather than several — the SDK refuses the second with `Cannot call
      // shutdown twice`.
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

  it('puts every signal on the real stderr and nothing on stdout', async () => {
    // Out of process against the real streams, which is the only place the
    // routing is observable — an in-process test is handed a stream and cannot
    // tell that `console` was not used. It also covers the flush against a
    // real pipe, where a write is asynchronous.
    const {stderr, stdout} = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {startTelemetry} = await import(${JSON.stringify(INDEX)});
         const {trace, metrics} = await import('@opentelemetry/api');
         const {logs} = await import('@opentelemetry/api-logs');
         const telemetry = await startTelemetry({stream: process.stderr});
         trace.getTracer('probe').startSpan('work').end();
         metrics.getMeter('probe').createCounter('orders').add(1);
         logs.getLogger('probe').emit({body: 'armed', severityText: 'INFO'});
         await telemetry.shutdown();`,
      ],
      {env: childEnv()}
    );

    assert.equal(stdout, '');
    assert.deepEqual(
      stderr
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.slice(0, line.indexOf(' ')))
        .sort(),
      ['log', 'metric', 'span']
    );
  });

  it('keeps a signal that asked for console off stdout', async () => {
    // Reached with a collector also configured, which is the case where
    // NodeSDK is otherwise left to build the exporters from the environment:
    // the span comes back on stderr while the other two go to the collector.
    const {stderr, stdout} = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {startTelemetry} = await import(${JSON.stringify(INDEX)});
         const {trace} = await import('@opentelemetry/api');
         const telemetry = await startTelemetry({stream: process.stderr});
         trace.getTracer('probe').startSpan('work').end();
         await telemetry.shutdown();`,
      ],
      {
        env: childEnv({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
          OTEL_TRACES_EXPORTER: 'console',
        }),
      }
    );

    assert.equal(stdout, '');
    assert.deepEqual(
      stderr
        .split('\n')
        .filter((line) => line.startsWith('span '))
        .map((line) => line.slice(0, 4)),
      ['span']
    );
  });
});
