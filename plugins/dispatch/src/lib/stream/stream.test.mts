import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {drain, ignoreWriteErrors} from './stream.mts';

describe('ignoreWriteErrors', () => {
  it('keeps a stream error from becoming an uncaught exception', () => {
    // A failed write emits `error` as well as calling back, and an unhandled
    // `error` on a stream ends the process.
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('EPIPE'));
      },
    });

    ignoreWriteErrors(stream).write('anything\n');

    assert.equal(stream.listenerCount('error'), 1);
  });

  it('guards a stream once however many writers share it', () => {
    // All three telemetry exporters are handed the same stderr, and one
    // listener per exporter would trip Node's max-listeners warning.
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    ignoreWriteErrors(stream);
    ignoreWriteErrors(stream);
    ignoreWriteErrors(stream);

    assert.equal(stream.listenerCount('error'), 1);
  });
});

describe('drain', () => {
  it('resolves only after the writes queued before it', async () => {
    // A flush needs to know the bytes left, not just that `write()` returned.
    const written: string[] = [];
    const slow = new Writable({
      write(chunk, _encoding, callback) {
        setTimeout(() => {
          written.push(String(chunk));
          callback();
        }, 5);
      },
    });

    slow.write('first\n');
    slow.write('second\n');
    const waiting = drain(slow);
    assert.deepEqual(written, [], 'nothing has been written yet');

    await waiting;

    assert.deepEqual(written, ['first\n', 'second\n', '']);
  });

  it('gives up on a stream that never calls back', async () => {
    // A command that will not exit is worse than a line that did not arrive,
    // so the wait is bounded. Without the bound this test never finishes.
    const wedged = new Writable({
      write() {
        // never calls back
      },
    });

    await drain(wedged, 10);
  });
});
