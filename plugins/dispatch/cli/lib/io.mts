import {once} from 'node:events';
import type {Writable} from 'node:stream';

/**
 * Write to a stream, respecting backpressure. `Writable.write` is
 * callback-based; awaiting `drain` when the buffer is full keeps the caller
 * promise-based and never drops output on a slow pipe.
 */
export async function write(stream: Writable, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}

export async function writeLine(stream: Writable, line: string): Promise<void> {
  await write(stream, `${line}\n`);
}
