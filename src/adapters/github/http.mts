import {
  classifyHttpStatus,
  GitHubError,
  parseRetryAfter,
  type GitHubErrorKind,
} from "./errors.mts";

export type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
export type FetchLike = (input: string, init: FetchInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Auth token resolver — called lazily, retried on auth failure. */
  token: () => Promise<string>;
  /** Override fetch (for tests). Default: globalThis.fetch. */
  fetch?: FetchLike;
  /** Override sleep (for tests). Default: setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Override clock (for tests). Default: Date.now. */
  now?: () => number;
  /** Max retries (excluding the initial attempt). Default: 4. */
  maxRetries?: number;
  /** Base backoff in ms. Default: 250. */
  baseBackoffMs?: number;
  /** Cap on backoff in ms. Default: 30_000. */
  maxBackoffMs?: number;
  /** API root. Default: https://api.github.com. */
  apiRoot?: string;
  /** GraphQL endpoint. Default: https://api.github.com/graphql. */
  graphqlRoot?: string;
  /** User-Agent header. */
  userAgent?: string;
}

export interface RequestOptions {
  /** Override accept header. */
  accept?: string;
  /** Optional JSON body. */
  body?: unknown;
  /** Extra headers (Authorization is always injected). */
  headers?: Record<string, string>;
}

export interface GraphQLOptions {
  variables?: Record<string, unknown>;
  operationName?: string;
}

export class GitHubHttpClient {
  readonly #token: () => Promise<string>;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #maxRetries: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #apiRoot: string;
  readonly #graphqlRoot: string;
  readonly #userAgent: string;

  constructor(opts: HttpClientOptions) {
    this.#token = opts.token;
    this.#fetch =
      opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = opts.now ?? (() => Date.now());
    this.#maxRetries = opts.maxRetries ?? 4;
    this.#baseBackoffMs = opts.baseBackoffMs ?? 250;
    this.#maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.#apiRoot = opts.apiRoot ?? "https://api.github.com";
    this.#graphqlRoot = opts.graphqlRoot ?? "https://api.github.com/graphql";
    this.#userAgent = opts.userAgent ?? "@ianwremmel/dispatch";
  }

  async rest<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = path.startsWith("http")
      ? path
      : `${this.#apiRoot}${path.startsWith("/") ? path : `/${path}`}`;
    return this.#request<T>(method, url, opts);
  }

  async graphql<T>(query: string, opts: GraphQLOptions = {}): Promise<T> {
    const body: Record<string, unknown> = { query };
    if (opts.variables !== undefined) body.variables = opts.variables;
    if (opts.operationName !== undefined)
      body.operationName = opts.operationName;
    const data = await this.#request<{
      data?: T;
      errors?: Array<{ message: string; type?: string }>;
    }>("POST", this.#graphqlRoot, { body });
    if (data.errors && data.errors.length > 0) {
      const message = data.errors.map((e) => e.message).join("; ");
      const isNotFound = data.errors.some((e) => e.type === "NOT_FOUND");
      throw new GitHubError(`graphql: ${message}`, {
        kind: isNotFound ? "not-found" : "client-4xx",
      });
    }
    if (data.data === undefined) {
      throw new GitHubError("graphql: empty response", { kind: "client-4xx" });
    }
    return data.data;
  }

  async #request<T>(
    method: string,
    url: string,
    opts: RequestOptions,
  ): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    for (;;) {
      let response: Response;
      try {
        const token = await this.#token();
        const headers: Record<string, string> = {
          authorization: `Bearer ${token}`,
          accept: opts.accept ?? "application/vnd.github+json",
          "user-agent": this.#userAgent,
          "x-github-api-version": "2022-11-28",
          ...opts.headers,
        };
        const init: FetchInit = { method, headers };
        if (opts.body !== undefined) {
          headers["content-type"] = "application/json";
          init.body = JSON.stringify(opts.body);
        }
        response = await this.#fetch(url, init);
      } catch (cause) {
        lastErr = new GitHubError(`network error: ${String(cause)}`, {
          kind: "network",
          cause,
        });
        if (!(await this.#shouldRetry("network", undefined, attempt))) {
          throw lastErr;
        }
        attempt++;
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (text.length === 0) return undefined as T;
        return JSON.parse(text) as T;
      }

      const kind = classifyHttpStatus(response.status, response.headers);
      const retryAfter = parseRetryAfter(response.headers, this.#now());
      // Drain to allow the connection to be reused.
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        // ignore
      }
      const detail = bodyText.length > 0 ? `: ${truncate(bodyText, 200)}` : "";
      lastErr = new GitHubError(
        `${method} ${redact(url)} -> ${response.status}${detail}`,
        { kind, status: response.status, retryAfter },
      );

      if (
        kind === "server-5xx" ||
        kind === "rate-limited" ||
        kind === "network"
      ) {
        if (await this.#shouldRetry(kind, retryAfter, attempt)) {
          attempt++;
          continue;
        }
      }
      throw lastErr;
    }
  }

  async #shouldRetry(
    kind: GitHubErrorKind,
    retryAfterMs: number | undefined,
    attempt: number,
  ): Promise<boolean> {
    if (attempt >= this.#maxRetries) return false;
    const wait =
      retryAfterMs !== undefined
        ? Math.min(retryAfterMs, this.#maxBackoffMs)
        : Math.min(this.#maxBackoffMs, this.#baseBackoffMs * 2 ** attempt);
    await this.#sleep(wait);
    // Reference kind to keep the parameter useful in subclasses/tests.
    void kind;
    return true;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function redact(url: string): string {
  return url.replace(/access_token=[^&]*/g, "access_token=REDACTED");
}
