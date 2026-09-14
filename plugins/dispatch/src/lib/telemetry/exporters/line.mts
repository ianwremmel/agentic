/**
 * The line format every exporter here writes, and the flush half they share.
 *
 * A line is a signal name and one JSON object: `span {"name":"…",…}`. The
 * record's name goes inside the object because it may contain a newline or the
 * delimiter. Resource attributes are left off: identical for every record in the
 * process, on the collector path regardless, and long enough to bury the record.
 */
import type {Writable} from 'node:stream';

import {ExportResultCode} from '@opentelemetry/core';
import type {ExportResult} from '@opentelemetry/core';

import {encode} from '../../encode/index.mts';
import {drain} from '../../stream/index.mts';

export const OK: ExportResult = {code: ExportResultCode.SUCCESS};

export function formatEnum(
  table: Record<number, string | undefined>,
  value: number
): string {
  return table[value] ?? String(value);
}

export function omitWhenEmpty<T extends object>(attributes: T): T | undefined {
  return Object.keys(attributes).length === 0 ? undefined : attributes;
}

/** One record, one line. Fields set to `undefined` are omitted. */
export function writeLine(
  stream: Writable,
  signal: string,
  fields: Record<string, unknown>
): void {
  stream.write(`${signal} ${encode(fields)}\n`);
}

/**
 * Neither method reports a failed write: a stream that cannot be written to has
 * no second channel to complain on, and a retry targets the same stream.
 */
export function createFlushMethods(stream: Writable): {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
} {
  return {
    forceFlush: (): Promise<void> => drain(stream),
    shutdown: (): Promise<void> => drain(stream),
  };
}
