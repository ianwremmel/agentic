import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {describe, it} from 'node:test';

import {
  createLogger,
  resolveLogLevel,
} from '../plugins/dispatch/cli/log/logger.mts';
import {encodeLine, encodeValue} from '../plugins/dispatch/cli/log/logfmt.mts';
import {UsageError} from '../plugins/dispatch/cli/errors.mts';
import {parseLogfmt} from './helpers/cli.mts';

describe('logfmt encoding', () => {
  it('leaves a bare value unquoted', () => {
    assert.equal(encodeValue('greet'), 'greet');
    assert.equal(encodeValue(42), '42');
    assert.equal(encodeValue(true), 'true');
  });

  it('quotes values a parser would otherwise mis-split', () => {
    assert.equal(encodeValue('Ada Lovelace'), '"Ada Lovelace"');
    assert.equal(encodeValue('a=b'), '"a=b"');
    assert.equal(encodeValue(''), '""');
  });

  it('escapes quotes, backslashes, and newlines inside a quoted value', () => {
    assert.equal(encodeValue('say "hi"'), '"say \\"hi\\""');
    assert.equal(encodeValue('C:\\tmp dir'), '"C:\\\\tmp dir"');
    assert.equal(encodeValue('one\ntwo'), '"one\\ntwo"');
  });

  it('round-trips a hostile value through encode and parse', () => {
    const hostile = 'name="Ada Lovelace"\nlevel=error \\ done';
    const parsed = parseLogfmt(encodeLine({msg: hostile, level: 'info'}));

    assert.deepEqual(parsed, {msg: hostile, level: 'info'});
  });

  it('drops undefined fields and keeps key order', () => {
    assert.equal(
      encodeLine({level: 'info', msg: 'greeted', name: undefined, count: 0}),
      'level=info msg=greeted count=0',
    );
  });
});

describe('logger', () => {
  const capture = () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    return {
      stream,
      lines: () => chunks.join('').trimEnd().split('\n').filter(Boolean),
    };
  };

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
      ['c', 'd'],
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
