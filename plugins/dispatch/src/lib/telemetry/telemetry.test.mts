import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {describe, it} from 'node:test';
import {promisify} from 'node:util';

import {metrics, trace} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';

import {
  buildChildEnv,
  capture,
  parseLine,
  runWithoutOtelEnv,
} from './test-support.mts';
import {flushAndStop, startTelemetry} from './telemetry.mts';

const execFileAsync = promisify(execFile);

const INDEX = new URL('./index.mts', import.meta.url).href;

describe('flushAndStop', () => {
  it('flushes every processor it owns before the SDK goes down', async () => {
    const order: string[] = [];
    const createFlushable = (
      name: string
    ): {forceFlush: () => Promise<void>} => ({
      forceFlush: async () => {
        await Promise.resolve();
        order.push(name);
      },
    });

    await flushAndStop(
      {
        shutdown: async () => {
          await Promise.resolve();
          order.push('sdk');
        },
      },
      [createFlushable('logs'), createFlushable('traces')],
      1_000
    );

    assert.deepEqual(order, ['logs', 'traces', 'sdk']);
  });

  it('stops the SDK even when a flush fails', async () => {
    // A stream that cannot be written to is no reason to leave the SDK running.
    let stopped = false;

    await flushAndStop(
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
    await flushAndStop(
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
    // `runWithoutOtelEnv` because `startTelemetry` reads `process.env` — the only
    // environment NodeSDK reads. A host OTEL_LOG_LEVEL would add diag lines to
    // the stream under assertion and a host endpoint would switch the branch.
    await runWithoutOtelEnv(async () => {
      const {readLines, stream} = capture();

      const telemetry = await startTelemetry({stream});

      trace.getTracer('probe').startSpan('work').end();
      metrics.getMeter('probe').createCounter('orders').add(1);
      logs.getLogger('probe').emit({body: 'armed', severityText: 'INFO'});

      // Nothing is written yet, and not only because the metric reader runs on
      // a timer: `hostDetector` resolves `host.id` asynchronously and the span
      // and log processors hold their records until the resource is complete.
      // A command short enough to finish first emits all three or none.
      assert.deepEqual(readLines(), []);

      // Several exit paths reach the shutdown, so it has to be one flush
      // rather than several — the SDK refuses the second with `Cannot call
      // shutdown twice`.
      const flush = telemetry.shutdown();
      assert.equal(telemetry.shutdown(), flush);
      await flush;

      assert.deepEqual(
        readLines()
          .map((line) => parseLine(line))
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
      {env: buildChildEnv()}
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
        env: buildChildEnv({
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
