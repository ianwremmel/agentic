import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {stderrDiagLogger} from './diag.mts';
import {capture} from './test-support.mts';

describe('stderrDiagLogger', () => {
  it('writes every level to the stream', () => {
    // Not a subset: `DiagConsoleLogger` splits across console methods and
    // sends debug, info, and verbose to stdout. This one has a single
    // destination, so the level is a label rather than a routing decision.
    const {lines, stream} = capture();
    const logger = stderrDiagLogger(stream);

    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    logger.verbose('v');

    assert.deepEqual(lines(), [
      'otel error e',
      'otel warn w',
      'otel info i',
      'otel debug d',
      'otel verbose v',
    ]);
  });

  it('appends the arguments the SDK passes alongside a message', () => {
    const {lines, stream} = capture();

    stderrDiagLogger(stream).debug('found resource', {'host.name': 'pod-0'}, 7);

    assert.deepEqual(lines(), [
      'otel debug found resource [{"host.name":"pod-0"},7]',
    ]);
  });

  it('keeps the message of an Error the SDK passes', () => {
    // The SDK reports its own failures this way, and `JSON.stringify` renders
    // an Error as `{}` — a diagnostic line that says nothing at all.
    const {lines, stream} = capture();

    stderrDiagLogger(stream).error('export failed', new Error('ECONNREFUSED'));

    const [line] = lines();
    assert.ok(line);
    assert.match(line, /ECONNREFUSED/u);
  });

  it('leaves a bare message bare', () => {
    const {lines, stream} = capture();

    stderrDiagLogger(stream).info('started');

    assert.deepEqual(lines(), ['otel info started']);
  });
});
