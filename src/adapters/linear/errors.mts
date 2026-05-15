export type LinearErrorKind =
  | "not-found"
  | "auth"
  | "rate-limited"
  | "server-5xx"
  | "network"
  | "client-4xx";

export interface LinearErrorOptions {
  kind: LinearErrorKind;
  status?: number;
  retryAfter?: number;
  cause?: unknown;
}

export class LinearError extends Error {
  readonly kind: LinearErrorKind;
  readonly status: number | undefined;
  readonly retryAfter: number | undefined;

  constructor(message: string, opts: LinearErrorOptions) {
    super(
      message,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = "LinearError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
  }
}

export function isLinearError(value: unknown): value is LinearError {
  return value instanceof LinearError;
}

export function classifyHttpStatus(status: number): LinearErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500 && status < 600) return "server-5xx";
  return "client-4xx";
}

export function classifyGraphqlError(message: string): LinearErrorKind {
  const m = message.toLowerCase();
  if (m.includes("authentication") || m.includes("not authorized"))
    return "auth";
  if (m.includes("not found") || m.includes("entity not found"))
    return "not-found";
  if (m.includes("rate limit")) return "rate-limited";
  return "client-4xx";
}
