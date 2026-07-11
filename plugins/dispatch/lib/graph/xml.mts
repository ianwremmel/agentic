/**
 * A minimal XML reader/writer for the project-graph documents.
 *
 * Plugins ship without dependencies, so this is hand-rolled. It handles exactly
 * the dialect these documents use — elements, attributes, nesting, comments, and
 * the five predefined entities — and rejects anything else rather than guessing.
 * There is no mixed content, no CDATA, and no namespaces.
 */

export interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Element[];
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  // A raw newline or tab in an attribute is legal to write but a conformant
  // reader folds it to a space, so encode it and the value survives the trip.
  '\n': '&#10;',
  '\r': '&#13;',
  '\t': '&#9;',
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Escape a value for an XML attribute. */
export function escape(value: string): string {
  return value.replace(/[&<>"'\n\r\t]/g, (c) => ESCAPES[c]!);
}

/**
 * Resolve the five predefined entities plus numeric character references.
 *
 * A bare `&` is rejected: an adapter that forgot to escape a title containing one
 * would otherwise parse cleanly into a wrong value.
 */
export function unescape(text: string): string {
  const resolved = text.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff)
        throw new Error(`invalid character reference: ${match}`);
      return String.fromCodePoint(code);
    }
    const entity = ENTITIES[body];
    if (entity === undefined) throw new Error(`unknown XML entity: ${match}`);
    return entity;
  });
  if (/&/.test(resolved.replace(/&(amp|lt|gt|quot|apos);/g, ''))) {
    // Every legal `&` was consumed above; anything left was never an entity.
    if (/&(?!#|[A-Za-z]+;)/.test(text)) throw new Error(`bare '&' in an attribute value: ${text}`);
  }
  return resolved;
}

export function el(name: string, attrs: Record<string, unknown> = {}, children: Element[] = []): Element {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    kept[key] = String(value);
  }
  return {name, attrs: kept, children};
}

/** Serialize an element tree. Childless elements collapse to `<name/>`. */
export function serialize(element: Element, indent = ''): string {
  const attrs = Object.entries(element.attrs)
    .map(([key, value]) => ` ${key}="${escape(value)}"`)
    .join('');
  if (element.children.length === 0) return `${indent}<${element.name}${attrs}/>`;
  const inner = element.children.map((child) => serialize(child, `${indent}  `)).join('\n');
  return `${indent}<${element.name}${attrs}>\n${inner}\n${indent}</${element.name}>`;
}

/**
 * Parse a document and return its root element.
 *
 * Deliberately strict: an unclosed tag, a mismatched closing tag, or trailing
 * junk throws. A silently mis-parsed graph would mis-schedule an entire run.
 */
export function parse(text: string): Element {
  let i = 0;

  const skip = (): void => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i += 1;
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i);
        if (end === -1) throw new Error('unterminated XML comment');
        i = end + 3;
        continue;
      }
      if (text.startsWith('<?', i)) {
        const end = text.indexOf('?>', i);
        if (end === -1) throw new Error('unterminated XML declaration');
        i = end + 2;
        continue;
      }
      return;
    }
  };

  const parseElement = (): Element => {
    if (text[i] !== '<') throw new Error(`expected '<' at offset ${i}`);
    i += 1;
    const name = readName();
    const attrs: Record<string, string> = {};

    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i += 1;
      if (text.startsWith('/>', i)) {
        i += 2;
        return {name, attrs, children: []};
      }
      if (text[i] === '>') {
        i += 1;
        break;
      }
      const key = readName();
      if (key in attrs) throw new Error(`duplicate attribute ${key} on <${name}>`);
      while (i < text.length && /\s/.test(text[i]!)) i += 1;
      if (text[i] !== '=') throw new Error(`expected '=' after attribute ${key}`);
      i += 1;
      while (i < text.length && /\s/.test(text[i]!)) i += 1;
      const quote = text[i];
      if (quote !== '"' && quote !== "'") throw new Error(`expected quoted value for ${key}`);
      i += 1;
      const end = text.indexOf(quote, i);
      if (end === -1) throw new Error(`unterminated value for attribute ${key}`);
      attrs[key] = unescape(text.slice(i, end));
      i = end + 1;
    }

    const children: Element[] = [];
    for (;;) {
      skip();
      if (text.startsWith('</', i)) {
        i += 2;
        const closing = readName();
        if (closing !== name) throw new Error(`</${closing}> closes <${name}>`);
        while (i < text.length && /\s/.test(text[i]!)) i += 1;
        if (text[i] !== '>') throw new Error(`expected '>' closing </${closing}>`);
        i += 1;
        return {name, attrs, children};
      }
      if (i >= text.length) throw new Error(`unclosed <${name}>`);
      if (text[i] !== '<') throw new Error(`unexpected text content in <${name}>`);
      children.push(parseElement());
    }
  };

  const readName = (): string => {
    const start = i;
    while (i < text.length && /[\w:.-]/.test(text[i]!)) i += 1;
    if (i === start) throw new Error(`expected a name at offset ${i}`);
    return text.slice(start, i);
  };

  skip();
  const root = parseElement();
  skip();
  if (i !== text.length) throw new Error(`trailing content after </${root.name}>`);
  return root;
}

/** All direct children named `name`. */
export function childrenNamed(element: Element, name: string): Element[] {
  return element.children.filter((child) => child.name === name);
}

/** The single child named `name`, or undefined. */
export function child(element: Element, name: string): Element | undefined {
  return element.children.find((c) => c.name === name);
}

/** Read an attribute as a boolean. Absent means false; only "true"/"false" parse. */
export function bool(element: Element, name: string): boolean | undefined {
  const raw = element.attrs[name];
  if (raw === undefined) return undefined;
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false, got "${raw}"`);
  return raw === 'true';
}

/**
 * Read an attribute as a number.
 *
 * An empty value is an error, not a zero: `order=""` read as 0 would make a
 * milestone the first in its project and gate every other one.
 */
export function num(element: Element, name: string): number | undefined {
  const raw = element.attrs[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value))
    throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}
