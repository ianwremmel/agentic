/**
 * Process exit codes the CLI produces. The caller is usually an agent, so the
 * code says what to *do* about a failure without parsing the message:
 *
 * | Code | Meaning                   | The caller's move                   |
 * | ---- | ------------------------- | ----------------------------------- |
 * | 0    | success                   | carry on                            |
 * | 1    | a bug in the CLI          | report it; retrying will not help   |
 * | 2    | the CLI was called wrong  | fix the invocation                  |
 * | 3    | the environment refused   | retry, or escalate to the operator  |
 * | 4    | the data was bad          | fix the payload or config, re-run   |
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_ENVIRONMENT = 3;
export const EXIT_DATA = 4;

export interface LandErrorOptions extends ErrorOptions {
  /** What to do about it, written for the agent that ran the command. */
  readonly hint?: string;
  /**
   * Facts about the failure — a path, a config key, a rejected value — rendered
   * by toString() after the message, so throw sites pass them as data instead
   * of splicing them into the message string.
   */
  readonly details?: Readonly<Record<string, string | number>>;
}

/** Render a thrown value for the printed failure, whatever it turned out to be. */
function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    // A value with no path to a primitive (e.g. a null-prototype object) must
    // not let the failure report itself throw.
    return Object.prototype.toString.call(cause);
  }
}

/**
 * The messages of a cause chain, outermost first. The set guards against a
 * cycle (an error wired up as its own cause) turning a failure report into a
 * hang.
 */
function describeChain(first: unknown): string[] {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  for (
    let cause = first;
    cause !== undefined && !seen.has(cause);
    cause = cause instanceof Error ? cause.cause : undefined
  ) {
    seen.add(cause);
    chain.push(describe(cause));
  }
  return chain;
}

/**
 * A failure the caller can act on, as opposed to a crash.
 *
 * The caller is an agent choosing between retrying, fixing its input, and
 * escalating to a human. It can only choose if the failure says which, so these
 * errors carry a hint alongside the exit code.
 */
export class LandError extends Error {
  override readonly name: string = 'LandError';
  readonly exitCode: number = EXIT_FAILURE;
  readonly hint: string | undefined;
  readonly details: Readonly<Record<string, string | number>> | undefined;

  constructor(message: string, options: LandErrorOptions = {}) {
    super(message, options);
    this.hint = options.hint;
    this.details = options.details;
  }

  /** The message with its details attached — what every toString() builds on. */
  protected get detailedMessage(): string {
    // Guarded beyond the declared type: a malformed details value from an
    // untyped caller must not make the failure report itself throw.
    const details: unknown = this.details;
    if (details === null || typeof details !== 'object') return this.message;
    const rendered = Object.entries(details)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');
    return rendered === '' ? this.message : `${this.message} (${rendered})`;
  }

  /**
   * The failure as the CLI prints it on the `error:` line — the message, its
   * details, then the messages of the cause chain it wraps. Owning the
   * formatting here lets a throw site pass the underlying error as `cause` and
   * the facts as `details` instead of splicing text into the message.
   */
  override toString(): string {
    return [this.detailedMessage, ...describeChain(this.cause)].join(': ');
  }
}

/** The caller invoked the CLI wrong: an unknown flag, a missing argument. */
export class UsageError extends LandError {
  override readonly name: string = 'UsageError';
  override readonly exitCode = EXIT_USAGE;
}

/**
 * The machine refused: an unwritable path, a missing tool, an unreachable
 * forge. The command was right; the environment was not, and often only for a
 * moment.
 */
export class EnvironmentError extends LandError {
  override readonly name = 'EnvironmentError';
  override readonly exitCode = EXIT_ENVIRONMENT;
}

/**
 * The input was malformed, or a forge returned something no mapping covers.
 * Retrying changes nothing — the data has to change.
 */
export class DataError extends LandError {
  override readonly name = 'DataError';
  override readonly exitCode = EXIT_DATA;
}

/**
 * `assert` for caller input. `node:assert` is the right tool for invariants the
 * caller cannot violate, but its AssertionError carries a stack trace and reads
 * as a crash; a bad flag is a usage error, so it gets its own assertion.
 *
 * Where the failure deserves a hint or details, use {@link ensure}.
 */
export function assertUsage(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new UsageError(message);
  }
}

/**
 * `assert` against a taxonomy error, built lazily: the factory only runs when
 * the assertion fails, so the passing path never pays for constructing the
 * error (or the strings inside it).
 */
export function ensure(
  condition: unknown,
  error: () => LandError
): asserts condition {
  if (!condition) {
    throw error();
  }
}
