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

export class ActionsAdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly exitCode: number | null | undefined;
  readonly signal: NodeJS.Signals | null | undefined;

  constructor(message: string, opts: AdapterErrorOptions) {
    super(
      message,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = "ActionsAdapterError";
    this.kind = opts.kind;
    this.exitCode = opts.exitCode;
    this.signal = opts.signal;
  }
}

export function isActionsAdapterError(
  value: unknown,
): value is ActionsAdapterError {
  return value instanceof ActionsAdapterError;
}
