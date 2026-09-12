import {Writable} from 'node:stream';

/**
 * The parent environment with every `OTEL_*` key removed, plus `overrides`.
 *
 * Every subprocess test here asserts on what did and did not reach a stream,
 * and the SDK is configured entirely from the environment — so a host or CI
 * runner that exports `OTEL_LOG_LEVEL`, an endpoint, or an exporter selector
 * would change what the child does and fail an assertion that has nothing to
 * do with it. Inheriting the rest matters: the child needs PATH and HOME to
 * run at all.
 */
export function childEnv(
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('OTEL_'))
    ),
    ...overrides,
  };
}

/**
 * Run `body` with every `OTEL_*` key gone from `process.env`, then put them
 * back.
 *
 * `childEnv` is the same protection for a subprocess; this is it for a test
 * that starts the SDK in-process. `startSdk` reads `process.env` directly —
 * it has to, because that is the only environment `NodeSDK` reads — so a host
 * `OTEL_LOG_LEVEL` adds diag lines to the stream under assertion, and a host
 * endpoint switches the exporter branch and makes the test measure something
 * else entirely.
 */
export async function withoutOtelEnv<T>(body: () => Promise<T>): Promise<T> {
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
    // Cleared again rather than just written over: restoring only what was
    // saved would leave behind any key the body added, so the environment the
    // next test sees would depend on what the last one did.
    clear();
    for (const [name, value] of saved) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

/** A stream that records what was written to it, one line per record. */
export function capture(): {lines: () => string[]; stream: Writable} {
  const chunks: string[] = [];
  return {
    lines: (): string[] =>
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

/**
 * The signal name and the JSON object of one exported line.
 *
 * `<signal> <json>` and nothing else, which is why this can split on the first
 * space: a span name or severity that contained the delimiter, or a newline,
 * would otherwise make the line unparseable, so both live inside the object.
 */
export function parse(line: string): {
  fields: Record<string, unknown>;
  signal: string;
} {
  const at = line.indexOf(' ');
  return {
    fields: JSON.parse(line.slice(at + 1)) as Record<string, unknown>,
    signal: line.slice(0, at),
  };
}
