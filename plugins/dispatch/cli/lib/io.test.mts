import assert from 'node:assert/strict';
import {PassThrough, Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {isPeerGone, write} from './io.mts';

describe('write', () => {
  it('writes what it is given', async () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    await write(stream, 'hello');

    assert.equal(chunks.join(''), 'hello');
  });

  it('ends quietly when the reader has gone', async () => {
    // `dispatch graph doc | head` closes the pipe mid-write; a crash report
    // would go to the same place nobody is reading.
    const stream = new PassThrough();
    stream.destroy();

    await write(stream, 'hello');
  });

  it('still raises a failure that is not a departed reader', async () => {
    const full = new Writable({
      write(_chunk, _encoding, done) {
        done(
          Object.assign(new Error('no space left on device'), {code: 'ENOSPC'})
        );
      },
    });
    // A failed write also emits on the stream, which the caller owns; here that
    // is the test, and an unlistened 'error' event would end the process.
    full.on('error', () => undefined);

    await assert.rejects(write(full, 'hello'), /no space left on device/u);
  });
});

describe('isPeerGone', () => {
  it('recognizes the codes a closed pipe raises', () => {
    assert.equal(
      isPeerGone(Object.assign(new Error('x'), {code: 'EPIPE'})),
      true
    );
    assert.equal(
      isPeerGone(Object.assign(new Error('x'), {code: 'ENOSPC'})),
      false
    );
    assert.equal(isPeerGone(new Error('x')), false);
    assert.equal(isPeerGone('EPIPE'), false);
  });
});
