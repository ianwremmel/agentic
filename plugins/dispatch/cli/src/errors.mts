/**
 * Errors are the CLI's contract with the agent that invoked it. Every failure
 * carries a stable exit code, a one-line statement of what went wrong, and a
 * `remedy` naming the concrete next action — so the calling agent can either
 * fix the call itself or escalate to the operator with something actionable.
 */

export const EXIT = {
  ok: 0,
  /** The agent called the CLI wrong: bad flags, malformed payload. */
  usage: 2,
  /** The environment is not fit: unreadable database, missing directory. */
  environment: 3,
  /** The data cannot be interpreted: an unmapped tracker state. Needs config. */
  data: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class DispatchError extends Error {
  readonly exitCode: ExitCode;
  readonly remedy: string;

  constructor(message: string, exitCode: ExitCode, remedy: string) {
    super(message);
    this.name = 'DispatchError';
    this.exitCode = exitCode;
    this.remedy = remedy;
  }
}

export class UsageError extends DispatchError {
  constructor(message: string, remedy: string) {
    super(message, EXIT.usage, remedy);
    this.name = 'UsageError';
  }
}

export class EnvironmentError extends DispatchError {
  constructor(message: string, remedy: string) {
    super(message, EXIT.environment, remedy);
    this.name = 'EnvironmentError';
  }
}

export class DataError extends DispatchError {
  constructor(message: string, remedy: string) {
    super(message, EXIT.data, remedy);
    this.name = 'DataError';
  }
}

/**
 * Render a failure for the invoking agent: the problem on one line, then the
 * remedy. Anything that is not a DispatchError is a bug in this CLI and says
 * so, so the agent escalates instead of trying to "fix" its own call.
 */
export function formatError(error: unknown): { text: string; code: ExitCode } {
  if (error instanceof DispatchError) {
    return {
      text: `dispatch: ${error.message}\n  remedy: ${error.remedy}`,
      code: error.exitCode,
    };
  }

  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return {
    text:
      `dispatch: internal error — this is a bug in the dispatch CLI, not in how you called it.\n` +
      `  remedy: report this to the operator with the trace below; do not retry blindly.\n${detail}`,
    code: EXIT.environment,
  };
}
