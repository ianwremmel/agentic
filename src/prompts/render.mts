/**
 * Minimal mustache-style placeholder renderer for prompt templates.
 *
 * Only the strict subset we actually need:
 *
 *   * `{{a.b.c}}` resolves a dotted path against a nested object and
 *     interpolates the result.
 *   * `\{{literal}}` (a backslash before the opening `{{`) emits a literal
 *     `{{literal}}` so prompt authors can talk about templates without
 *     fighting the renderer.
 *   * Unknown paths throw — we never want a silently-empty
 *     `{{event.author}}` slipping into a runner prompt.
 *
 * We deliberately do **not** depend on the `mustache` package. We don't
 * need sections, lambdas, partials, or HTML escaping; the spec explicitly
 * forbids HTML escaping (prompts are not HTML), and the SEA binary stays
 * smaller without a third-party templating engine.
 */

/**
 * A nested "vars" object. Values are stored as `unknown` so the renderer
 * can validate them at interpolation time rather than at the type level —
 * callers typically pass an `event` object that was just parsed from JSON.
 */
export type RenderVars = Record<string, unknown>;

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

/**
 * Walks `vars` along `path` (dot-separated). Returns the leaf value if
 * every step exists, otherwise `undefined`. Arrays are indexed by numeric
 * segments (e.g. `event.reviewers.0.login`).
 */
function lookup(vars: RenderVars, path: string): unknown {
  const segments = path.split(".");
  let cur: unknown = vars;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number.parseInt(seg, 10);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function stringify(value: unknown): string {
  // Booleans, numbers, and strings are interpolated directly. Objects/arrays
  // are JSON-stringified — handy for `{{event.payload}}` in stub templates,
  // refined templates will reach into the object via dotted paths anyway.
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Render a mustache-style template against `vars`. See module docstring
 * for grammar. Throws `RenderError` on any unknown placeholder.
 */
export function render(template: string, vars: RenderVars): string {
  // Single-pass scanner: walk the input, copying literal characters and
  // emitting interpolated values at every unescaped `{{ … }}`. A simple
  // `replace(/{{...}}/g, ...)` would mis-handle the `\{{` escape because
  // there's no way to express "preceded by an unescaped backslash" cleanly
  // in JS regex.
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "\\" && template[i + 1] === "{" && template[i + 2] === "{") {
      // Escaped opener: emit the literal `{{` and consume the backslash.
      out += "{{";
      i += 3;
      continue;
    }
    if (ch === "{" && template[i + 1] === "{") {
      const end = template.indexOf("}}", i + 2);
      if (end === -1) {
        throw new RenderError(
          `unterminated placeholder starting at position ${i}`,
        );
      }
      const expr = template.slice(i + 2, end).trim();
      if (expr.length === 0) {
        throw new RenderError(`empty placeholder at position ${i}`);
      }
      const value = lookup(vars, expr);
      if (value === undefined || value === null) {
        throw new RenderError(`unknown placeholder: {{${expr}}}`);
      }
      out += stringify(value);
      i = end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
