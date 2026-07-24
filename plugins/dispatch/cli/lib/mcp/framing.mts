import {createInterface} from 'node:readline';
import type {Writable} from 'node:stream';

import {writeLine} from '../io.mts';

/**
 * MCP's stdio transport is newline-delimited JSON: one message per line, and
 * nothing else on the stream. This module owns that framing in both directions
 * so no other part of the server writes to the peer's stdout by hand.
 */

export interface ReadMessagesOptions {
  /** Aborting ends the iteration, which is how the server stops on a signal. */
  readonly signal?: AbortSignal;
}

/**
 * The non-empty lines of `input`, in order.
 *
 * `readline` owns the buffering: a message split across chunks, several
 * messages in one chunk, and a `\r\n` peer all read the same. Blank lines are
 * skipped rather than reported as parse errors — they frame no message.
 */
export async function* readMessages(
  input: NodeJS.ReadableStream,
  {signal}: ReadMessagesOptions = {}
): AsyncGenerator<string> {
  if (signal?.aborted === true) {
    return;
  }

  const reader = createInterface({input, crlfDelay: Infinity});
  const close = (): void => {
    reader.close();
  };
  signal?.addEventListener('abort', close, {once: true});

  try {
    for await (const line of reader) {
      const message = line.trim();
      if (message !== '') {
        yield message;
      }
    }
  } finally {
    signal?.removeEventListener('abort', close);
    reader.close();
  }
}

/**
 * Frame one message onto `output`.
 *
 * `JSON.stringify` escapes any newline inside a string, so an encoded message
 * can never split itself across two lines. Backpressure is respected, since the
 * peer reading us is a pipe that can fill.
 */
export async function writeMessage(
  output: Writable,
  message: object
): Promise<void> {
  await writeLine(output, JSON.stringify(message));
}
