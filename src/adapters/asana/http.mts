import { AsanaError, classifyHttpStatus } from "./errors.mts";

export type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
export type FetchLike = (input: string, init: FetchInit) => Promise<Response>;

export interface HttpClientOptions {
  pat: () => Promise<string>;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  baseUrl?: string;
  userAgent?: string;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

const DEFAULT_BASE_URL = "https://app.asana.com/api/1.0";

export class AsanaHttpClient {
  readonly #pat: () => Promise<string>;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #maxRetries: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #baseUrl: string;
  readonly #userAgent: string;

  constructor(opts: HttpClientOptions) {
    this.#pat = opts.pat;
    this.#fetch =
      opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = opts.now ?? (() => Date.now());
    this.#maxRetries = opts.maxRetries ?? 4;
    this.#baseBackoffMs = opts.baseBackoffMs ?? 250;
    this.#maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.#baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.#userAgent = opts.userAgent ?? "@ianwremmel/dispatch";
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.#buildUrl(path, opts.query);
    const method = opts.method ?? "GET";
    const body =
      opts.body === undefined ? undefined : JSON.stringify({ data: opts.body });

    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        const pat = await this.#pat();
        const headers: Record<string, string> = {
          authorization: `Bearer ${pat}`,
          accept: "application/json",
          "user-agent": this.#userAgent,
        };
        if (body !== undefined) headers["content-type"] = "application/json";
        response = await this.#fetch(url, { method, headers, body });
      } catch (cause) {
        const err = new AsanaError(`network error: ${String(cause)}`, {
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
        const err = new AsanaError(
          `asana ${method} ${path} ${response.status}${detail}`,
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

      if (response.status === 204) return undefined as T;
      const text = await response.text();
      const payload = JSON.parse(text) as {
        data?: T;
        errors?: Array<{ message: string }>;
      };
      if (payload.errors !== undefined && payload.errors.length > 0) {
        const message = payload.errors.map((e) => e.message).join("; ");
        throw new AsanaError(`asana: ${message}`, { kind: "client-4xx" });
      }
      if (payload.data === undefined) {
        throw new AsanaError("asana: empty response", { kind: "client-4xx" });
      }
      return payload.data;
    }
  }

  #buildUrl(
    path: string,
    query: Record<string, string | number | boolean | undefined> | undefined,
  ): string {
    const url = new URL(
      path.startsWith("/") ? path.slice(1) : path,
      `${this.#baseUrl}/`,
    );
    if (query !== undefined) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
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
