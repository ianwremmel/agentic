import type {Writable} from 'node:stream';

import {assertUsage} from '../errors.mts';
import {writeLine} from '../io.mts';
import {encodeLine, type LogFields} from './logfmt.mts';

/** Ordered by severity; a logger emits a record iff its level index is >= the configured one. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): Promise<void>;
  info(message: string, fields?: LogFields): Promise<void>;
  warn(message: string, fields?: LogFields): Promise<void>;
  error(message: string, fields?: LogFields): Promise<void>;
}

export interface LoggerOptions {
  /** Where lines go. Always stderr in production — stdout carries command output. */
  readonly stream: Writable;
  readonly level?: LogLevel;
  /** Injectable for tests. */
  readonly now?: () => Date;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve a log level from a flag or environment value, falling back to
 * {@link DEFAULT_LOG_LEVEL} when neither is set. Throws a usage error on an
 * unrecognized name rather than silently logging at the wrong level.
 */
export function resolveLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) {
    return DEFAULT_LOG_LEVEL;
  }
  const normalized = value.trim().toLowerCase();
  assertUsage(
    isLogLevel(normalized),
    `unknown log level "${value}"; expected one of ${LOG_LEVELS.join(', ')}`
  );
  return normalized;
}

export function createLogger({
  stream,
  level = DEFAULT_LOG_LEVEL,
  now = () => new Date(),
}: LoggerOptions): Logger {
  const threshold = LOG_LEVELS.indexOf(level);

  const emit = async (
    recordLevel: LogLevel,
    message: string,
    fields: LogFields = {}
  ): Promise<void> => {
    if (LOG_LEVELS.indexOf(recordLevel) < threshold) {
      return;
    }
    await writeLine(
      stream,
      encodeLine({
        ts: now().toISOString(),
        level: recordLevel,
        msg: message,
        ...fields,
      })
    );
  };

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
