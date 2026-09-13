/**
 * JSON for one line of telemetry.
 *
 * Exporting runs inside the caller's own `emit()` or `end()`, so a throw here
 * takes down the code being observed. Bare `JSON.stringify` throws on a
 * `BigInt` and on a self-referencing record, and renders an `Error` — which
 * `diag` is handed routinely — as `{}`.
 *
 * The circular check tracks every object already written rather than the
 * ancestor chain, so a shared reference reads as `[circular]` on its second
 * appearance. Cosmetic, in a record that is already pathological.
 *
 * The outer catch is what makes the no-throw guarantee total: a value can
 * still refuse to serialize from a throwing getter or `toJSON()`, which the
 * replacer never gets to see.
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
