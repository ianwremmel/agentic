/**
 * XML escaping for the `pr-status` document. Two escapers, matching the
 * protocol: attribute values additionally escape the double quote that would
 * otherwise close the value; element text does not.
 */

/** Escape a value for element text: the three characters that break parsing. */
export function text(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Escape a value for a double-quoted XML attribute. */
export function attr(value: string): string {
  return text(value).replaceAll('"', '&quot;');
}

/**
 * Render one element: self-closing when it has no children, else opened over its
 * child lines and closed at the same indent. `attrs` is the already-joined
 * attribute string (each value pre-escaped by the caller).
 */
export function element(
  indent: string,
  tag: string,
  attrs: string,
  childLines: readonly string[] = []
): string {
  if (childLines.length === 0) return `${indent}<${tag} ${attrs}/>`;
  return [
    `${indent}<${tag} ${attrs}>`,
    ...childLines,
    `${indent}</${tag}>`,
  ].join('\n');
}
