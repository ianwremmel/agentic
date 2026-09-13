import {EnvironmentError, ensure} from '../errors/index.mts';

/**
 * How an error names the row it is about: whichever identifying field did come
 * back, so a hundred-row page says which one failed rather than only that one
 * did. Blank counts as absent — a blank label names nothing.
 */
export function nameRow(...candidates: (string | null | undefined)[]): string {
  return (
    candidates.find((value) => value != null && value !== '') ??
    '(unidentified)'
  );
}

export function buildDroppedError(field: string, of: string): EnvironmentError {
  return new EnvironmentError(
    `linear answered without the ${field} of ${of} it was asked for`,
    {
      hint: "retry the scan; if it repeats, either something is answering in Linear's place or the query no longer selects that field.",
    }
  );
}

/**
 * A field the query selects, refused when it did not come back rather than
 * defaulted. GraphQL reports an absent field as `null` rather than by dropping
 * the key, so both are refused — asking only about `undefined` would pass the
 * shape Linear actually sends.
 */
export function requireField<TValue>(
  value: TValue | null | undefined,
  field: string,
  of: string
): TValue {
  ensure(value !== null && value !== undefined, () =>
    buildDroppedError(field, of)
  );
  return value;
}

/**
 * A field something is matched on: an id, an identifier, a workflow state.
 * Empty is refused as well as absent, because `''` reaches the graph as a
 * project nothing matches, which reads exactly like a project with no work in
 * it. A display name is deliberately not this — an oddly named row is still a
 * real row, and refusing it would fail the whole scan over one of them.
 */
export function requireKey(
  value: string | null | undefined,
  field: string,
  of: string
): string {
  const found = requireField(value, field, of);
  ensure(found !== '', () => buildDroppedError(field, of));
  return found;
}

/** Linear orders milestones by this, so a value that cannot be compared is not one. */
export function requireSortOrder(
  value: number | null | undefined,
  of: string
): number {
  const found = requireField(value, 'sortOrder', of);
  ensure(Number.isFinite(found), () => buildDroppedError('sortOrder', of));
  return found;
}
