/**
 * JSON for one line of telemetry.
 *
 * `JSON.stringify` on its own is not enough on three counts, all of which the
 * SDK and its callers can actually produce: an `Error` — which `diag` is
 * handed routinely, and which a caller attaches to a record — serializes to
 * `{}`, losing the only part worth reading; a `BigInt` throws; and a record
 * whose attributes reference themselves throws. A throw is not survivable
 * here, because exporting runs inside the caller's own `emit()` or `end()`,
 * so a bad attribute would take down the code being observed.
 *
 * A field whose value is `undefined` is omitted, which is how a line stays
 * short rather than carrying nulls for everything a record had nothing to say
 * about.
 *
 * The circular check tracks every object already written rather than the
 * current ancestor chain, so the second appearance of a shared reference reads
 * as `[circular]` too. That is a cosmetic defect in a pathological record and
 * not worth the bookkeeping to fix.
 */
export function encode(value: unknown): string {
  const seen = new WeakSet<object>();
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
}
