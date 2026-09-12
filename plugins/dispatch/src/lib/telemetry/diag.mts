import type {Writable} from 'node:stream';

import type {DiagLogFunction, DiagLogger} from '@opentelemetry/api';

import {encode} from './encode.mts';
import {forgiving} from './stream.mts';

/** What the SDK itself complains about, as opposed to what it exports. */
const LEVELS = ['error', 'warn', 'info', 'debug', 'verbose'] as const;

/**
 * The SDK's internal logger, bound to a stream — bind it to stderr.
 *
 * `DiagConsoleLogger` cannot be used: it splits across `console` methods, and
 * `debug`, `info`, and `verbose` go to stdout — the stream `dispatch mcp`
 * serves JSON-RPC on. This logger has one destination, so the level is a label
 * rather than a routing decision.
 *
 * The SDK hands these calls `Error` objects routinely, which is why the
 * arguments go through `encode` rather than `JSON.stringify`: the latter
 * renders an `Error` as `{}`, throwing away the only part worth reading.
 */
export function stderrDiagLogger(stream: Writable): DiagLogger {
  const out = forgiving(stream);
  const write =
    (level: string): DiagLogFunction =>
    (message: string, ...args: unknown[]): void => {
      out.write(
        args.length === 0
          ? `otel ${level} ${message}\n`
          : `otel ${level} ${message} ${encode(args)}\n`
      );
    };

  const logger = {} as Record<(typeof LEVELS)[number], DiagLogFunction>;
  for (const level of LEVELS) logger[level] = write(level);
  return logger;
}
