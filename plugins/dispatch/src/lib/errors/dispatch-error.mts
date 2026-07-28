export interface DispatchErrorOptions extends ErrorOptions {
  /** What to do about it, written for the agent that ran the command. */
  readonly hint?: string;
}

/** A failure the caller can act on, as opposed to a crash. */
export class DispatchError extends Error {
  override readonly name: string = 'DispatchError';
  readonly exitCode: number = 1;
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
