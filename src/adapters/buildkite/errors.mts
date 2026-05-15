export type AdapterErrorKind =
  | "binary-not-found"
  | "subprocess-crashed"
  | "parse-error"
  | "io-error";

export interface AdapterErrorOptions {
  kind: AdapterErrorKind;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  cause?: unknown;
}

export class BuildkiteAdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly exitCode: number | null | undefined;
  readonly signal: NodeJS.Signals | null | undefined;

  constructor(message: string, opts: AdapterErrorOptions) {
    super(
      message,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = "BuildkiteAdapterError";
    this.kind = opts.kind;
    this.exitCode = opts.exitCode;
    this.signal = opts.signal;
  }
}

export function isBuildkiteAdapterError(
  value: unknown,
): value is BuildkiteAdapterError {
  return value instanceof BuildkiteAdapterError;
}
