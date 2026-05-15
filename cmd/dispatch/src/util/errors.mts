export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}
