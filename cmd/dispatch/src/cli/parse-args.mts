import { parseArgs as nodeParseArgs, type ParseArgsConfig } from "node:util";

import { UsageError } from "../util/errors.mts";

export type FlagSchema = NonNullable<ParseArgsConfig["options"]>;

export interface ParsedFlags<F extends FlagSchema> {
  values: {
    [K in keyof F]: F[K] extends { type: "string"; multiple: true }
      ? string[] | undefined
      : F[K] extends { type: "string" }
        ? string | undefined
        : F[K] extends { type: "boolean" }
          ? boolean | undefined
          : never;
  };
  positionals: string[];
}

/**
 * Wrap node:util parseArgs with our usage error type and stricter defaults.
 *
 * We always set `allowPositionals: true` and `strict: true` so that unknown
 * flags surface as a UsageError (exit 2) instead of an opaque crash.
 */
export function parseFlags<F extends FlagSchema>(
  argv: string[],
  options: F,
): ParsedFlags<F> {
  try {
    const parsed = nodeParseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
    return parsed as unknown as ParsedFlags<F>;
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}
