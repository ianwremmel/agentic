import type {OptionsRecord} from './abstract-command.mts';
import {assertUsage} from '../errors/index.mts';

/**
 * Turn a raw values map (keyed by option name) into a validated values record.
 * Transport-neutral: the cli builds `raw` from argv, an MCP server from JSON.
 */
export function parseOptions(
  options: OptionsRecord,
  raw: Readonly<Record<string, string | boolean>>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, option] of Object.entries(options)) {
    const provided = raw[key];

    if (provided === undefined) {
      if (option.type === 'boolean') {
        result[key] = false;
      } else if (option.default !== undefined) {
        result[key] = option.default;
      } else {
        assertUsage(!option.required, `missing required option: ${key}`);
      }
      continue;
    }

    if (option.type === 'boolean') {
      result[key] = provided === true || provided === 'true';
      continue;
    }

    const text = String(provided);
    if (option.type === 'number') {
      const value = Number(text);
      assertUsage(
        text.trim() !== '' && !Number.isNaN(value),
        `option ${key} expects a number, got "${text}"`
      );
      result[key] = value;
      continue;
    }

    if (option.choices !== undefined) {
      assertUsage(
        option.choices.includes(text),
        `option ${key} must be one of: ${option.choices.join(', ')}`
      );
    }
    result[key] = text;
  }

  return result;
}
