import type {Writable} from 'node:stream';

/**
 * Writing telemetry to a stream, and knowing when it has actually left.
 *
 * Both halves are load-bearing. A stream whose write fails emits `error` as
 * well as calling back, and an unhandled `error` on a stream is an uncaught
 * exception — so telemetry could take down the process it is observing over a
 * closed pipe, which `dispatch … | head` produces as a matter of course. And
 * a write to a pipe is asynchronous, so bytes sit in the stream's buffer until
 * the event loop gets to them; a caller that exits without waiting loses them.
 */

/** How long a flush waits for the stream before giving up on it. */
const FLUSH_TIMEOUT_MS = 2_000;

const guarded = new WeakSet<Writable>();

/**
 * Make a stream's write failures survivable, once per stream.
 *
 * This covers every writer of the stream, not only telemetry. For stderr that
 * is the right trade: there is no second channel to report a broken stderr on,
 * and a CLI that dies because its diagnostics had nowhere to go is worse than
 * one that runs quietly.
 */
export function forgiving(stream: Writable): Writable {
  if (!guarded.has(stream)) {
    guarded.add(stream);
    stream.on('error', () => undefined);
  }
  return stream;
}

/**
 * Resolve once everything written so far has been handed to the OS.
 *
 * A write callback fires only after every write queued before it, so one more
 * write of nothing is the cheapest way to wait for all of them. This is what a
 * signal's immediate re-raise would otherwise cut short: re-raising after
 * 20,000 buffered stderr lines delivers about 3,000 of them.
 *
 * Bounded, because a stream nobody is reading never calls back and a command
 * that will not exit is worse than a line that did not arrive. The timer is
 * unref'd so it cannot be what holds the process open.
 */
export function drained(
  stream: Writable,
  timeoutMs: number = FLUSH_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    stream.write('', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
