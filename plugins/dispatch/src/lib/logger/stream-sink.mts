import type {Writable} from 'node:stream';

import {LEVELS} from './logger.mts';
import type {CoreLogger} from './logger.mts';

/**
 * A logger sink that writes one line per call to a stream — bind it to stderr.
 * The default `console` sink sends `log`, `info`, and `debug` to stdout, which
 * `dispatch mcp` owns as its JSON-RPC channel: one diagnostic line there is a
 * protocol error for the client parsing it.
 */
export function streamSink(stream: Writable): CoreLogger {
  const write = (message: string, meta?: Record<string, unknown>): void => {
    stream.write(
      meta === undefined
        ? `${message}\n`
        : `${message} ${JSON.stringify(meta)}\n`
    );
  };
  const sink = {} as CoreLogger;
  for (const level of LEVELS) sink[level] = write;
  return sink;
}
