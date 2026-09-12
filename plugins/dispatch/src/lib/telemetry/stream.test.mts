import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {drained, forgiving} from './stream.mts';

describe('forgiving', () => {
  it('keeps a stream error from becoming an uncaught exception', () => {
    // A write that fails emits `error` as well as calling back, and an
    // unhandled `error` on a stream ends the process. Telemetry must not be
    // able to take down the command it is observing over a closed pipe, which
    // `dispatch … | head` produces as a matter of course.
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('EPIPE'));
      },
    });

    forgiving(stream).write('anything\n');

    assert.equal(stream.listenerCount('error'), 1);
  });

  it('guards a stream once however many exporters share it', () => {
    // All three exporters are handed the same stderr; three no-op listeners
    // would be two too many and would trip Node's max-listeners warning as
    // soon as anything else listened.
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    forgiving(stream);
    forgiving(stream);
    forgiving(stream);

    assert.equal(stream.listenerCount('error'), 1);
  });
});

describe('drained', () => {
  it('resolves only after the writes queued before it', async () => {
    // This is the guarantee a signal's immediate re-raise needs: the handler
    // has to know the bytes left, not just that `write()` returned.
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
    const waiting = drained(slow);
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

    await drained(wedged, 10);
  });
});
