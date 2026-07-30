export interface DispatchErrorOptions extends ErrorOptions {
  /** What to do about it, written for the agent that ran the command. */
  readonly hint?: string;
}

/**
 * An intended, caller-actionable failure, as opposed to a crash — the root of
 * every deliberate error the plugin throws, so one `instanceof` tells the two
 * apart. Command failures (`CommandError`) and transport-protocol failures
 * (`JsonRpcError`) both extend it; the root itself holds no transport-specific
 * field, only the `hint` and rendering common to all of them.
 */
export class DispatchError extends Error {
  override readonly name: string = 'DispatchError';
  readonly hint: string | undefined;

  constructor(message: string, options: DispatchErrorOptions = {}) {
    super(message, options);
    this.hint = options.hint;
  }

  override toString(): string {
    return this.hint === undefined
      ? `${this.name}: ${this.message}`
      : `${this.name}: ${this.message}\nhint: ${this.hint}`;
  }
}
