/**
 * JSON that cannot throw, for a caller with nowhere to report a failure —
 * telemetry exporting runs inside the observed code's own `emit()` or `end()`.
 *
 * Bare `JSON.stringify` throws on a `BigInt` and on a self-referencing value, and
 * renders an `Error` as `{}`. The circular check tracks every object already
 * written rather than the ancestor chain, so a shared reference also reads as
 * `[circular]`.
 *
 * The outer catch is what makes the guarantee total: a throwing getter or
 * `toJSON()` fails where the replacer never sees it.
 */
export function encode(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, field: unknown): unknown => {
      if (field instanceof Error) {
        return {message: field.message, name: field.name, stack: field.stack};
      }
      if (typeof field === 'bigint') return field.toString();
      if (typeof field === 'symbol') return field.toString();
      if (typeof field === 'object' && field !== null) {
        if (seen.has(field)) return '[circular]';
        seen.add(field);
      }
      return field;
    });
  } catch (error) {
    return JSON.stringify({
      '[unencodable]': error instanceof Error ? error.message : String(error),
    });
  }
}
