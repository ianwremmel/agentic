// Minimal POSIX-style argv parser. No third-party dependency. Handles
// the subset of conventions the dispatch CLI commits to:
//
//   --flag           boolean true
//   --flag=value     string  "value"
//   --flag value     string  "value"          (when FlagSpec.kind != boolean)
//   --no-flag        boolean false            (only for boolean flags)
//   -x               short alias for a boolean
//   -x value         short alias for a string flag
//   --               end of options; the rest is positional / rest
//   value            positional
//
// String[] flags may be repeated.

import { DispatchError, ExitCode } from "./errors.mts";
import type {
  CommandSpec,
  FlagSpec,
  ParsedArgs,
  PositionalSpec,
} from "./types.mts";

interface FlagLookup {
  byLong: Map<string, FlagSpec>;
  byShort: Map<string, FlagSpec>;
}

function buildLookup(flags: readonly FlagSpec[]): FlagLookup {
  const byLong = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const f of flags) {
    byLong.set(f.name, f);
    if (f.alias) byShort.set(f.alias, f);
  }
  return { byLong, byShort };
}

function usageError(cmd: string, message: string): never {
  throw new DispatchError(ExitCode.USAGE, message, cmd);
}

function applyDefault(spec: FlagSpec): string | boolean | string[] | undefined {
  if (spec.kind === "boolean") {
    return typeof spec.default === "boolean" ? spec.default : false;
  }
  if (spec.kind === "string[]") return [];
  return typeof spec.default === "string" ? spec.default : undefined;
}

function setStringValue(
  cmd: string,
  spec: FlagSpec,
  value: string,
  flags: ParsedArgs["flags"],
): void {
  if (spec.choices && !spec.choices.includes(value)) {
    usageError(
      cmd,
      `flag --${spec.name} must be one of ${spec.choices.join(", ")} (got "${value}")`,
    );
  }
  if (spec.kind === "string[]") {
    const existing = flags[spec.name];
    const list = Array.isArray(existing) ? existing : [];
    list.push(value);
    flags[spec.name] = list;
  } else {
    flags[spec.name] = value;
  }
}

export interface ParseResult {
  parsed: ParsedArgs;
  // `--help` was requested for this command. The router renders help
  // and exits 0 without invoking the handler.
  helpRequested: boolean;
}

export function parseCommandArgs(
  command: CommandSpec,
  argv: readonly string[],
): ParseResult {
  const lookup = buildLookup(command.flags);
  const parsed: ParsedArgs = { flags: {}, positionals: {}, rest: [] };
  for (const f of command.flags) parsed.flags[f.name] = applyDefault(f);

  const positionalQueue: PositionalSpec[] = [...command.positionals];
  let helpRequested = false;
  let i = 0;
  let stoppedOpts = false;

  while (i < argv.length) {
    const tokenRaw = argv[i];
    if (tokenRaw === undefined) break;
    const token: string = tokenRaw;
    i++;

    if (stoppedOpts) {
      parsed.rest.push(token);
      continue;
    }
    if (token === "--") {
      stoppedOpts = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      helpRequested = true;
      continue;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);

      // Negation: --no-foo for boolean flags.
      if (name.startsWith("no-")) {
        const base = name.slice(3);
        const spec = lookup.byLong.get(base);
        if (spec && spec.kind === "boolean") {
          parsed.flags[spec.name] = false;
          continue;
        }
      }
      const spec = lookup.byLong.get(name);
      if (!spec) usageError(command.name, `unknown flag --${name}`);
      if (spec.kind === "boolean") {
        if (inline !== undefined) {
          if (inline === "true") parsed.flags[spec.name] = true;
          else if (inline === "false") parsed.flags[spec.name] = false;
          else
            usageError(
              command.name,
              `boolean flag --${spec.name} does not accept value "${inline}"`,
            );
        } else {
          parsed.flags[spec.name] = true;
        }
        continue;
      }
      let value: string;
      if (inline !== undefined) value = inline;
      else {
        const next = argv[i];
        if (next === undefined || next.startsWith("-"))
          usageError(command.name, `flag --${spec.name} requires a value`);
        value = next;
        i++;
      }
      setStringValue(command.name, spec, value, parsed.flags);
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      // Short flag; we only support single-char aliases.
      const short = token.slice(1);
      if (short.length !== 1)
        usageError(command.name, `unknown short flag -${short}`);
      const spec = lookup.byShort.get(short);
      if (!spec) usageError(command.name, `unknown short flag -${short}`);
      if (spec.kind === "boolean") {
        parsed.flags[spec.name] = true;
        continue;
      }
      const next = argv[i];
      if (next === undefined || next.startsWith("-"))
        usageError(command.name, `flag -${short} requires a value`);
      i++;
      setStringValue(command.name, spec, next, parsed.flags);
      continue;
    }

    // Positional.
    const slot = positionalQueue.shift();
    if (!slot) {
      parsed.rest.push(token);
      continue;
    }
    parsed.positionals[slot.name] = token;
  }

  if (helpRequested) return { parsed, helpRequested };

  // Required-flag enforcement.
  for (const f of command.flags) {
    if (!f.required) continue;
    const value = parsed.flags[f.name];
    if (
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      usageError(command.name, `missing required flag --${f.name}`);
    }
  }

  // Required-positional enforcement.
  for (const p of command.positionals) {
    if (p.required && !parsed.positionals[p.name]) {
      usageError(command.name, `missing required argument <${p.name}>`);
    }
  }

  if (command.validate) {
    const err = command.validate(parsed);
    if (err) usageError(command.name, err);
  }

  return { parsed, helpRequested };
}
