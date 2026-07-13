/** Values a log field may carry. `undefined` fields are omitted from the line. */
export type LogValue = string | number | boolean | undefined;

export type LogFields = Record<string, LogValue>;

/** Bare (unquoted) logfmt values may not contain these. */
const NEEDS_QUOTING = /["=\s]/u;

/**
 * Encode one value. Quoted iff it is empty or contains whitespace, `"`, or `=`;
 * inside quotes, backslashes, quotes, and newlines are escaped.
 */
export function encodeValue(value: Exclude<LogValue, undefined>): string {
  const text = String(value);
  if (text !== '' && !NEEDS_QUOTING.test(text)) {
    return text;
  }
  const escaped = text
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
  return `"${escaped}"`;
}

/**
 * Encode fields as a logfmt line (no trailing newline). Key order is preserved;
 * `undefined` values are dropped so callers can pass optional fields inline.
 */
export function encodeLine(fields: LogFields): string {
  return Object.entries(fields)
    .filter(
      (entry): entry is [string, Exclude<LogValue, undefined>] =>
        entry[1] !== undefined,
    )
    .map(([key, value]) => `${key}=${encodeValue(value)}`)
    .join(' ');
}
