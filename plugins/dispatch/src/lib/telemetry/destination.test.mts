import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {diag, DiagLogLevel} from '@opentelemetry/api';

import {
  hasOtlpEndpoint,
  resolveDestination,
  warnOnConsolePairing,
} from './destination.mts';
import {createDiagLogger} from './exporters/diag.mts';
import {capture} from './test-support.mts';

const ENDPOINTS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
];

const COLLECTOR = {OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318'};

describe('hasOtlpEndpoint', () => {
  it('is false with nothing set', () => {
    assert.equal(hasOtlpEndpoint({}), false);
  });

  for (const name of ENDPOINTS) {
    it(`is true on ${name} alone`, () => {
      // A per-signal endpoint counts: the signals without one fall back to the
      // OTLP default, per spec, so reading only the generic variable would send
      // the rest to stderr.
      assert.equal(hasOtlpEndpoint({[name]: 'http://collector:4318'}), true);
    });
  }

  it('treats an empty value as unset', () => {
    // Unsetting an inherited variable in a shell or container spec means
    // assigning it nothing.
    assert.equal(hasOtlpEndpoint({OTEL_EXPORTER_OTLP_ENDPOINT: ''}), false);
  });

  it('treats a whitespace-only value as unset', () => {
    // The SDK's own reader trims before testing for empty, so without this a
    // signal goes to an endpoint the SDK will not use and stderr never sees it.
    assert.equal(hasOtlpEndpoint({OTEL_EXPORTER_OTLP_ENDPOINT: '  '}), false);
  });
});

describe('resolveDestination', () => {
  it('goes to the stream with no collector and no selector', () => {
    assert.equal(resolveDestination({}, 'traces'), 'stream');
  });

  it('goes to the SDK with a collector and no selector', () => {
    assert.equal(resolveDestination(COLLECTOR, 'traces'), 'sdk');
  });

  it('turns a signal off when its selector says none', () => {
    // Naming a stderr processor anyway would export telemetry that was
    // explicitly switched off.
    assert.equal(
      resolveDestination({OTEL_TRACES_EXPORTER: 'none'}, 'traces'),
      'off'
    );
  });

  it('serves console from the stream even with a collector configured', () => {
    assert.equal(
      resolveDestination(
        {...COLLECTOR, OTEL_TRACES_EXPORTER: 'console'},
        'traces'
      ),
      'stream'
    );
  });

  it('keeps the real exporter when a selector pairs it with console', () => {
    // Serving console means naming the processor, which turns off NodeSDK's
    // environment handling for the whole signal — so `otlp,console` served from
    // the stream would silently drop the collector.
    assert.equal(
      resolveDestination(
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
        resolveDestination(env, signal)
      ),
      ['off', 'stream', 'stream']
    );
  });

  it('does not match a name that merely contains console', () => {
    assert.equal(
      resolveDestination({OTEL_TRACES_EXPORTER: 'consolefoo'}, 'traces'),
      'sdk'
    );
  });
});

describe('warnOnConsolePairing', () => {
  /** What the warning puts through the global diag logger. */
  function captureWarnings(env: NodeJS.ProcessEnv): string[] {
    const {readLines, stream} = capture();
    diag.setLogger(createDiagLogger(stream), {
      logLevel: DiagLogLevel.WARN,
      suppressOverrideMessage: true,
    });
    warnOnConsolePairing(env);
    return readLines();
  }

  it('names the selector whose console request is being dropped', () => {
    // Dropping it silently would leave someone waiting on console output that
    // never comes, having asked for it correctly.
    assert.deepEqual(
      captureWarnings({OTEL_TRACES_EXPORTER: 'otlp,console'}).map((line) =>
        line.slice(0, line.indexOf(';'))
      ),
      [
        'otel warn OTEL_TRACES_EXPORTER lists console alongside another exporter',
      ]
    );
  });

  it('warns about a console the selector spells in capitals', () => {
    // `resolveDestination` lowercases, so a case-sensitive warning would stay
    // quiet on exactly the selector whose console request it just dropped.
    assert.equal(
      captureWarnings({OTEL_TRACES_EXPORTER: 'otlp,CONSOLE'}).length,
      1
    );
  });

  it('says nothing about a selector that asks for console alone', () => {
    assert.deepEqual(captureWarnings({OTEL_TRACES_EXPORTER: 'console'}), []);
  });

  it('says nothing when console survives alongside none', () => {
    // `none,console` still routes to the stream, so there is nothing to warn
    // about — the warning has to follow the routing decision, not the spelling.
    assert.deepEqual(
      captureWarnings({OTEL_TRACES_EXPORTER: 'none,console'}),
      []
    );
  });

  it('says nothing when no selector mentions console', () => {
    assert.deepEqual(captureWarnings({OTEL_TRACES_EXPORTER: 'otlp'}), []);
  });
});
