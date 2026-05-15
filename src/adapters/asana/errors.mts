export type AsanaErrorKind =
  | "not-found"
  | "auth"
  | "rate-limited"
  | "server-5xx"
  | "network"
  | "client-4xx";

export interface AsanaErrorOptions {
  kind: AsanaErrorKind;
  status?: number;
  retryAfter?: number;
  cause?: unknown;
}

export class AsanaError extends Error {
  readonly kind: AsanaErrorKind;
  readonly status: number | undefined;
  readonly retryAfter: number | undefined;

  constructor(message: string, opts: AsanaErrorOptions) {
    super(
      message,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = "AsanaError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
  }
}

export function isAsanaError(value: unknown): value is AsanaError {
  return value instanceof AsanaError;
}

export function classifyHttpStatus(status: number): AsanaErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500 && status < 600) return "server-5xx";
  return "client-4xx";
}
