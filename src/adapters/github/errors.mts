export type GitHubErrorKind =
  | "not-found"
  | "auth"
  | "rate-limited"
  | "server-5xx"
  | "network"
  | "client-4xx";

export interface GitHubErrorOptions {
  kind: GitHubErrorKind;
  status?: number;
  retryAfter?: number;
  cause?: unknown;
}

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  readonly status: number | undefined;
  readonly retryAfter: number | undefined;

  constructor(message: string, opts: GitHubErrorOptions) {
    super(
      message,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = "GitHubError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
  }
}

export function isGitHubError(value: unknown): value is GitHubError {
  return value instanceof GitHubError;
}

export function classifyHttpStatus(
  status: number,
  headers?: Headers,
): GitHubErrorKind {
  if (status === 401 || status === 403) {
    if (headers && isRateLimited(status, headers)) {
      return "rate-limited";
    }
    return "auth";
  }
  if (status === 404) {
    return "not-found";
  }
  if (status === 429) {
    return "rate-limited";
  }
  if (status >= 500 && status < 600) {
    return "server-5xx";
  }
  if (status >= 400 && status < 500) {
    return "client-4xx";
  }
  return "client-4xx";
}

export function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  if (status === 403) {
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining !== null && Number(remaining) === 0) return true;
    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null) return true;
  }
  return false;
}

export function parseRetryAfter(
  headers: Headers,
  now: number,
): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.ceil(seconds * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const sec = Number(reset);
    if (Number.isFinite(sec)) {
      return Math.max(0, sec * 1000 - now);
    }
  }
  return undefined;
}
