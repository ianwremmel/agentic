import type {Writable} from 'node:stream';

/**
 * Node's codes for "the other end of this pipe is gone" — the reader closed
 * (`dispatch graph doc | head`), or the process that spawned us took its
 * streams down.
 */
const PEER_GONE_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_WRITE_AFTER_END',
]);

export function isPeerGone(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code: unknown = 'code' in error ? error.code : undefined;
  return typeof code === 'string' && PEER_GONE_CODES.has(code);
}

/**
 * Write to a stream, reporting whatever the write hit.
 *
 * The callback form is what makes a failure reachable: a stream the reader
 * already took down never drains, so waiting on `drain` would hang instead of
 * failing, and its `error` event can fire before a listener is even attached.
 */
export async function writeOrFail(
  stream: Writable,
  chunk: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) {
      reject(
        Object.assign(new Error('the stream is closed'), {
          code: 'ERR_STREAM_DESTROYED',
        })
      );
      return;
    }
    stream.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Write to a stream, treating a departed reader as nothing to report: there is
 * nobody left to tell, and a command whose output pipe closed should end
 * quietly rather than as a crash. Callers that must react to it — the channel
 * server, for which a departed peer is the end of the session — use
 * {@link writeOrFail}.
 */
export async function write(stream: Writable, chunk: string): Promise<void> {
  try {
    await writeOrFail(stream, chunk);
  } catch (error) {
    if (!isPeerGone(error)) throw error;
  }
}

export async function writeLine(stream: Writable, line: string): Promise<void> {
  await write(stream, `${line}\n`);
}
