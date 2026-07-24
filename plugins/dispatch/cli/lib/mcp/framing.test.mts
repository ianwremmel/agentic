import assert from 'node:assert/strict';
import {PassThrough, Readable} from 'node:stream';
import {describe, it} from 'node:test';

import {readMessages, writeMessage} from './framing.mts';

async function collect(
  input: NodeJS.ReadableStream,
  options?: {signal: AbortSignal}
): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readMessages(input, options ?? {})) {
    lines.push(line);
  }
  return lines;
}

describe('readMessages', () => {
  it('yields one message per line', async () => {
    const input = Readable.from(['{"a":1}\n{"b":2}\n']);

    assert.deepEqual(await collect(input), ['{"a":1}', '{"b":2}']);
  });

  it('reassembles a message split across chunks', async () => {
    const input = Readable.from(['{"a":', '1}\n']);

    assert.deepEqual(await collect(input), ['{"a":1}']);
  });

  it('reads a CRLF peer the same as an LF one', async () => {
    const input = Readable.from(['{"a":1}\r\n{"b":2}\r\n']);

    assert.deepEqual(await collect(input), ['{"a":1}', '{"b":2}']);
  });

  it('skips blank lines, which frame no message', async () => {
    const input = Readable.from(['\n{"a":1}\n   \n']);

    assert.deepEqual(await collect(input), ['{"a":1}']);
  });

  it('yields a trailing message the peer never terminated', async () => {
    const input = Readable.from(['{"a":1}']);

    assert.deepEqual(await collect(input), ['{"a":1}']);
  });

  it('stops on an abort, without waiting for the stream to end', async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    input.write('{"a":1}\n');

    const lines: string[] = [];
    for await (const line of readMessages(input, {signal: controller.signal})) {
      lines.push(line);
      controller.abort();
    }

    assert.deepEqual(lines, ['{"a":1}']);
    assert.equal(input.destroyed, false, 'the caller still owns the stream');
  });

  it('reads nothing when the signal is already aborted', async () => {
    const input = Readable.from(['{"a":1}\n']);

    assert.deepEqual(await collect(input, {signal: AbortSignal.abort()}), []);
  });
});

/** Everything written to a stream, as the peer would read it. */
function sink(): {stream: PassThrough; written: () => string} {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return {stream, written: () => chunks.join('')};
}

describe('writeMessage', () => {
  it('writes one line per message', async () => {
    const {stream, written} = sink();

    await writeMessage(stream, {a: 1});
    await writeMessage(stream, {b: 2});

    assert.equal(written(), '{"a":1}\n{"b":2}\n');
  });

  it('escapes a newline inside a message so it cannot split the frame', async () => {
    const {stream, written} = sink();

    await writeMessage(stream, {message: 'first\nsecond'});

    assert.equal(written().split('\n').filter(Boolean).length, 1);
    assert.deepEqual(JSON.parse(written()), {message: 'first\nsecond'});
  });
});
