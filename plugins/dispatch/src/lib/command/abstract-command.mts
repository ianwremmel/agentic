import type {Logger} from '../logger/index.mts';

export type OptionType = 'string' | 'number' | 'boolean';

export interface Option {
  readonly type: OptionType;
  readonly description: string;
  /** Consumes a positional argument instead of a `--flag`. */
  readonly positional: boolean;
  /** Absent at parse time is a usage error. */
  readonly required: boolean;
  /** Ignored for `boolean` options: an absent boolean flag is always `false`. */
  readonly default?: string | number | boolean;
  /**
   * String options only; a value outside the set is a usage error. Ignored
   * (has no effect at the type level or at runtime) for `number`/`boolean`.
   */
  readonly choices?: readonly string[];
}

export type OptionsRecord = Readonly<Record<string, Option>>;

export type OptionValue<O extends Option> = O extends {readonly type: 'boolean'}
  ? boolean
  : O extends {readonly type: 'number'}
    ? number
    : O extends {readonly choices: readonly (infer C extends string)[]}
      ? C
      : O extends {readonly type: 'string'}
        ? string
        : never;

export type IsPresent<O extends Option> = O extends {readonly type: 'boolean'}
  ? true
  : O extends {readonly required: true}
    ? true
    : O extends {readonly default: string | number | boolean}
      ? true
      : false;

export type PresentKeys<O extends OptionsRecord> = {
  [K in keyof O]: IsPresent<O[K]> extends true ? K : never;
}[keyof O];

/** The value a command's `run` receives: present keys required, the rest optional. */
export type ParsedOptions<O extends OptionsRecord> = {
  [K in PresentKeys<O>]: OptionValue<O[K]>;
} & {
  [K in Exclude<keyof O, PresentKeys<O>>]?: OptionValue<O[K]>;
};

/**
 * What a command is handed at run time. The logger is injected so commands stay
 * callable outside a process; `env` is the source for `assertEnv`.
 */
export interface CommandContext {
  readonly log: Logger;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The transport-neutral command contract. The framework-facing `run` takes an
 * already-validated values record; a subclass overrides it with a signature
 * typed from its own options const (`ParsedOptions<typeof options>`), which
 * method-parameter bivariance accepts.
 */
export abstract class AbstractCommand {
  abstract readonly name: string;
  abstract readonly summary: string;
  abstract readonly env: readonly string[];
  abstract readonly options: OptionsRecord;
  abstract run(
    parsed: Record<string, unknown>,
    ctx: CommandContext
  ): Promise<void>;
}
