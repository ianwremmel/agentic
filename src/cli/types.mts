// Declarative shapes for the subcommand registry. The router uses
// these to parse, validate, and render help — handlers never see raw
// argv.

export type FlagKind = "boolean" | "string" | "string[]";

export interface FlagSpec {
  // Long name without the leading `--`.
  name: string;
  // Optional single-character short alias (without the leading `-`).
  alias?: string;
  kind: FlagKind;
  description: string;
  required?: boolean;
  // Allowed values; the parser rejects anything outside this list.
  choices?: readonly string[];
  // Default value applied when the flag is absent. Only meaningful
  // for non-required flags. `string[]` defaults are not supported;
  // the parser returns `[]` when no value is supplied.
  default?: string | boolean;
}

export interface PositionalSpec {
  name: string;
  description: string;
  required?: boolean;
}

export interface ParsedArgs {
  // Resolved flag values keyed by FlagSpec.name. Booleans default to
  // false unless overridden by `default`. Strings default to undefined
  // when optional and absent.
  flags: Record<string, string | boolean | string[] | undefined>;
  // Positional arguments in the order declared by the command, keyed
  // by PositionalSpec.name.
  positionals: Record<string, string | undefined>;
  // Anything past the declared positionals (currently unused; kept
  // for forward compatibility with commands that take a passthrough
  // tail like `daemon start -- ...`).
  rest: string[];
}

export type CommandHandler = (
  parsed: ParsedArgs,
  ctx: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
) => Promise<void> | void;

export interface CommandSpec {
  // Space-separated command path, e.g. "daemon start" or "add-ticket".
  name: string;
  summary: string;
  // Optional longer description shown by `<cmd> --help`.
  description?: string;
  flags: readonly FlagSpec[];
  positionals: readonly PositionalSpec[];
  // Cross-flag validation (e.g. mutually exclusive flags). Returns a
  // human-readable error message, or `null` if the parsed args are
  // valid. Per-flag rules are enforced by the parser.
  validate?: (parsed: ParsedArgs) => string | null;
  handler: CommandHandler;
}
