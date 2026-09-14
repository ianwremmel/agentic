import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {capture} from '../test-support.mts';
import {createDiagLogger} from './diag.mts';

describe('createDiagLogger', () => {
  it('writes every level to the stream', () => {
    const {readLines, stream} = capture();
    const logger = createDiagLogger(stream);

    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    logger.verbose('v');

    assert.deepEqual(readLines(), [
      'otel error e',
      'otel warn w',
      'otel info i',
      'otel debug d',
      'otel verbose v',
    ]);
  });

  it('appends the arguments the SDK passes alongside a message', () => {
    const {readLines, stream} = capture();

    createDiagLogger(stream).debug('found resource', {'host.name': 'pod-0'}, 7);

    assert.deepEqual(readLines(), [
      'otel debug found resource [{"host.name":"pod-0"},7]',
    ]);
  });

  it('keeps the message of an Error the SDK passes', () => {
    // The SDK reports its own failures this way.
    const {readLines, stream} = capture();

    createDiagLogger(stream).error('export failed', new Error('ECONNREFUSED'));

    const [line] = readLines();
    assert.ok(line);
    assert.match(line, /ECONNREFUSED/u);
  });

  it('leaves a bare message bare', () => {
    const {readLines, stream} = capture();

    createDiagLogger(stream).info('started');

    assert.deepEqual(readLines(), ['otel info started']);
  });
});
