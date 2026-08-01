import {DataError, ensure} from '../errors/index.mts';

/**
 * RFC 3339 shape, checked before Date.parse: V8 also accepts local formats like
 * "07/31/2026", which would record an instant the caller never meant.
 */
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;

/** The current instant as a Zulu ISO-8601 string — what callers stamp rows with. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Reject a timestamp that is not RFC 3339, where the fix is naming the field. */
export function assertInstant(value: string, field: string): void {
  ensure(
    RFC3339_RE.test(value) && !Number.isNaN(Date.parse(value)),
    () =>
      new DataError(`${field} is not an RFC 3339 timestamp: "${value}"`, {
        hint: `pass an instant like 2026-07-31T12:00:00Z, or omit ${field}.`,
      })
  );
}
