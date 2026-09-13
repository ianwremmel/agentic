import type {Writable} from 'node:stream';

/** How long a flush waits for the stream before giving up on it. */
const FLUSH_TIMEOUT_MS = 2_000;

const guarded = new WeakSet<Writable>();

/**
 * Make a stream's write failures survivable, once per stream.
 *
 * An unhandled `error` on a stream is an uncaught exception, so without this a
 * closed pipe — `dispatch … | head` — lets telemetry kill the process it is
 * observing. The guard covers every writer of the stream, not only telemetry.
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
 * write of nothing waits for all of them. Bounded, because a stream nobody is
 * reading never calls back.
 *
 * The timer is not unref'd: the caller awaits this from a top-level `await`,
 * where an unref'd timer is not a handle that keeps the loop alive, so Node
 * would exit 13 on the unsettled await rather than take the timeout. It is
 * cleared as soon as the write lands.
 */
export function drained(
  stream: Writable,
  timeoutMs: number = FLUSH_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    stream.write('', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
