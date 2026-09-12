import {Writable} from 'node:stream';

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
