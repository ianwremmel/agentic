import {
  classifyGraphqlError,
  classifyHttpStatus,
  LinearError,
} from "./errors.mts";

export type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
export type FetchLike = (input: string, init: FetchInit) => Promise<Response>;

export interface HttpClientOptions {
  apiKey: () => Promise<string>;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  endpoint?: string;
  userAgent?: string;
}

export interface GraphQLOptions {
  variables?: Record<string, unknown>;
  operationName?: string;
}

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

export class LinearHttpClient {
  readonly #apiKey: () => Promise<string>;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #maxRetries: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #endpoint: string;
  readonly #userAgent: string;

  constructor(opts: HttpClientOptions) {
    this.#apiKey = opts.apiKey;
    this.#fetch =
      opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = opts.now ?? (() => Date.now());
    this.#maxRetries = opts.maxRetries ?? 4;
    this.#baseBackoffMs = opts.baseBackoffMs ?? 250;
    this.#maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.#endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.#userAgent = opts.userAgent ?? "@ianwremmel/dispatch";
  }

  async graphql<T>(query: string, opts: GraphQLOptions = {}): Promise<T> {
    const body: Record<string, unknown> = { query };
    if (opts.variables !== undefined) body.variables = opts.variables;
    if (opts.operationName !== undefined)
      body.operationName = opts.operationName;
    return this.#withRetry<T>(body);
  }

  async #withRetry<T>(body: Record<string, unknown>): Promise<T> {
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        const apiKey = await this.#apiKey();
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: {
            // Linear uses the API key directly, no Bearer prefix.
            authorization: apiKey,
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": this.#userAgent,
          },
          body: JSON.stringify(body),
        });
      } catch (cause) {
        const err = new LinearError(`network error: ${String(cause)}`, {
          kind: "network",
          cause,
        });
        if (await this.#shouldRetry(undefined, attempt)) {
          attempt++;
          continue;
        }
        throw err;
      }

      if (!response.ok) {
        const kind = classifyHttpStatus(response.status);
        const retryAfter = parseRetryAfter(response.headers, this.#now());
        const bodyText = await safeText(response);
        const detail =
          bodyText.length > 0 ? `: ${truncate(bodyText, 200)}` : "";
        const err = new LinearError(
          `linear graphql ${response.status}${detail}`,
          { kind, status: response.status, retryAfter },
        );
        if (
          (kind === "server-5xx" || kind === "rate-limited") &&
          (await this.#shouldRetry(retryAfter, attempt))
        ) {
          attempt++;
          continue;
        }
        throw err;
      }

      const text = await response.text();
      const payload = JSON.parse(text) as {
        data?: T;
        errors?: Array<{ message: string; extensions?: { type?: string } }>;
      };
      if (payload.errors !== undefined && payload.errors.length > 0) {
        const message = payload.errors.map((e) => e.message).join("; ");
        const kind =
          payload.errors[0]?.extensions?.type === "AuthenticationError"
            ? "auth"
            : classifyGraphqlError(message);
        throw new LinearError(`linear graphql: ${message}`, { kind });
      }
      if (payload.data === undefined) {
        throw new LinearError("linear graphql: empty response", {
          kind: "client-4xx",
        });
      }
      return payload.data;
    }
  }

  async #shouldRetry(
    retryAfterMs: number | undefined,
    attempt: number,
  ): Promise<boolean> {
    if (attempt >= this.#maxRetries) return false;
    const wait =
      retryAfterMs !== undefined
        ? Math.min(retryAfterMs, this.#maxBackoffMs)
        : Math.min(this.#maxBackoffMs, this.#baseBackoffMs * 2 ** attempt);
    await this.#sleep(wait);
    return true;
  }
}

function parseRetryAfter(headers: Headers, now: number): number | undefined {
  const v = headers.get("retry-after");
  if (v === null) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec) && sec >= 0) return Math.ceil(sec * 1000);
  const at = Date.parse(v);
  if (!Number.isNaN(at)) return Math.max(0, at - now);
  return undefined;
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
