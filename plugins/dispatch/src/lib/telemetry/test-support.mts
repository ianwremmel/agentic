import {Writable} from 'node:stream';

import {logs} from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import type {ReadableLogRecord} from '@opentelemetry/sdk-logs';

export interface LogCapture {
  /** Everything emitted since the last `reset`. */
  read: () => ReadableLogRecord[];
  reset: () => void;
}

let recording: LogCapture | undefined;

/**
 * Collect what `lib/telemetry`'s `log` emits, in memory.
 *
 * Registering the global logger provider is what makes `log` resolve to
 * anything, and `log` keeps whichever provider it resolved first — so this is
 * memoized rather than per-call, and a test that wants to read only its own
 * records calls `reset` first. Node runs each test file in its own process,
 * which is what keeps one file's registration out of another's way.
 *
 * Registering after something else already has yields a capture nothing writes
 * to, so that case throws rather than returning an empty reader: a test
 * asserting on no records would otherwise pass for the wrong reason.
 */
export function captureLogs(): LogCapture {
  if (recording === undefined) {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({exporter})],
    });
    if (logs.setGlobalLoggerProvider(provider) !== provider) {
      throw new Error(
        'a logger provider was already registered in this process; call captureLogs() before anything starts the SDK'
      );
    }
    recording = {
      read: () => exporter.getFinishedLogRecords(),
      reset: () => {
        exporter.reset();
      },
    };
  }
  return recording;
}

/**
 * The parent environment with every `OTEL_*` key removed, plus `overrides`. A
 * host or CI runner that exports one would reconfigure the SDK under test.
 */
export function buildChildEnv(
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('OTEL_'))
    ),
    ...overrides,
  };
}

/** `buildChildEnv` for a test that starts the SDK in-process rather than in a child. */
export async function runWithoutOtelEnv<T>(body: () => Promise<T>): Promise<T> {
  const saved = Object.entries(process.env).filter(([name]) =>
    name.startsWith('OTEL_')
  );
  const clear = (): void => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('OTEL_')) Reflect.deleteProperty(process.env, name);
    }
  };

  clear();
  try {
    return await body();
  } finally {
    // Cleared again, not just written over: restoring only what was saved would
    // leave behind any key the body added.
    clear();
    for (const [name, value] of saved) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

/** A stream that records what was written to it, one line per record. */
export function capture(): {readLines: () => string[]; stream: Writable} {
  const chunks: string[] = [];
  return {
    readLines: (): string[] =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line !== ''),
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
  };
}

/** Split one `<signal> <json>` line. */
export function parseLine(line: string): {
  fields: Record<string, unknown>;
  signal: string;
} {
  const at = line.indexOf(' ');
  return {
    fields: JSON.parse(line.slice(at + 1)) as Record<string, unknown>,
    signal: line.slice(0, at),
  };
}
