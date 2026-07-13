import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {describe, it} from 'node:test';

import {parseLogfmt} from '../../../test-harness.mts';
import {UsageError} from '../errors.mts';
import {createLogger, resolveLogLevel} from './logger.mts';

const capture = () => {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return {
    stream,
    lines: () => chunks.join('').trimEnd().split('\n').filter(Boolean),
  };
};

describe('logger', () => {
  it('writes one logfmt record per call, with ts, level, and msg first', async () => {
    const {stream, lines} = capture();
    const log = createLogger({
      stream,
      level: 'debug',
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    await log.info('greeted', {name: 'Ada Lovelace'});

    assert.deepEqual(lines(), [
      'ts=2026-07-13T12:00:00.000Z level=info msg=greeted name="Ada Lovelace"',
    ]);
  });

  it('suppresses records below the configured level', async () => {
    const {stream, lines} = capture();
    const log = createLogger({stream, level: 'warn'});

    await log.debug('a');
    await log.info('b');
    await log.warn('c');
    await log.error('d');

    assert.deepEqual(
      lines().map((line) => parseLogfmt(line).msg),
      ['c', 'd']
    );
  });
});

describe('resolveLogLevel', () => {
  it('defaults to info when unset', () => {
    assert.equal(resolveLogLevel(undefined), 'info');
  });

  it('normalizes case and surrounding space', () => {
    assert.equal(resolveLogLevel(' DEBUG '), 'debug');
  });

  it('rejects an unknown level as a usage error', () => {
    assert.throws(() => resolveLogLevel('chatty'), UsageError);
  });
});
