import type {Writable} from 'node:stream';

const DRAIN_TIMEOUT_MS = 2_000;

const guarded = new WeakSet<Writable>();

/**
 * One error handler per stream, so a failed write cannot end the process. A
 * closed pipe — `dispatch … | head` — would otherwise let a background writer
 * such as telemetry kill the process it observes.
 */
export function ignoreWriteErrors(stream: Writable): Writable {
  if (!guarded.has(stream)) {
    guarded.add(stream);
    stream.on('error', () => undefined);
  }
  return stream;
}

/**
 * Resolve once everything written so far has been handed to the OS: a write
 * callback fires only after every write queued before it, so one more write of
 * nothing waits for all of them. Bounded, because a stream nobody reads never
 * calls back.
 *
 * The timer is referenced, not unref'd: a caller awaiting this from a top-level
 * `await` — `src/main.mts` does — would let Node exit 13 on the unsettled await
 * rather than take the timeout.
 */
export function drain(
  stream: Writable,
  timeoutMs: number = DRAIN_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    stream.write('', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
