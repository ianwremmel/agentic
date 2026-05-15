// Exit codes per §3.2 of the dispatch spec. These are part of the
// public contract of the CLI: scripts that wrap dispatch rely on
// distinct codes for distinct failure modes.
export const ExitCode = {
  SUCCESS: 0,
  GENERIC: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  PRECONDITION: 4,
  AUTH: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

// Errors raised by the router or a command handler. The router catches
// these, formats them to stderr per §3.2, and exits with `code`.
export class DispatchError extends Error {
  readonly code: ExitCode;
  // Subcommand path that produced the error, e.g. "daemon start". Set
  // by the router; handlers can leave it undefined.
  readonly command?: string;

  constructor(code: ExitCode, message: string, command?: string) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    this.command = command;
  }
}
