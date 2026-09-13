import {Writable} from 'node:stream';

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
