import {
  DataError,
  DefinitionError,
  EnvironmentError,
  ensure,
} from '../errors/index.mts';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';
export const LINEAR_TOKEN_VAR = 'LINEAR_API_KEY';

/** Long enough for a page of issues, short enough that a hung call cannot stall a server tick. */
const DEFAULT_TIMEOUT_MS = 30_000;

export type Fetcher = typeof globalThis.fetch;

export interface ExecuteInput {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
  /** Caller's own cancellation, combined with the per-request timeout. */
  readonly signal?: AbortSignal;
}

/** One GraphQL round trip. The client talks to this, so tests need no HTTP. */
export type GraphqlExecutor = <TData>(input: ExecuteInput) => Promise<TData>;

export interface TransportOptions {
  readonly token: string;
  readonly endpoint?: string;
  readonly fetch?: Fetcher;
  readonly timeoutMs?: number;
}

interface GraphqlError {
  readonly message?: string;
  readonly extensions?: {readonly type?: string; readonly code?: string};
}

interface GraphqlBody<TData> {
  readonly data?: TData | null;
  readonly errors?: readonly GraphqlError[];
}

const BEARER = /^Bearer\s+/iu;

/**
 * Linear takes a personal API key as the bare `Authorization` value — a
 * `Bearer` prefix on one is an error it answers with HTTP 400 — so the key is
 * sent as written, minus that prefix if someone added it. Anything else goes
 * through untouched, which is how an OAuth token gets its `Bearer`: written
 * into the variable.
 */
export function authorization(token: string): string {
  const trimmed = token.trim();
  const bare = trimmed.replace(BEARER, '');
  return bare.startsWith('lin_api_') ? bare : trimmed;
}

/**
 * What each Linear error is. `code` is the stable discriminator;
 * `extensions.type` is prose that has changed before, so it is only a fallback.
 */
function faultOf(
  code: string,
  type: string
): 'ratelimited' | 'auth' | 'schema' | 'input' | 'unknown' {
  if (code === 'RATELIMITED' || type === 'ratelimited') return 'ratelimited';
  if (code === 'AUTHENTICATION_ERROR' || type === 'authentication error') {
    return 'auth';
  }
  if (code === 'GRAPHQL_VALIDATION_FAILED' || type === 'graphql error') {
    return 'schema';
  }
  if (code === 'INPUT_ERROR' || type === 'invalid input') return 'input';
  return 'unknown';
}

/** Most explanatory first: the one worth telling the caller about. */
const FAULT_ORDER = ['ratelimited', 'auth', 'schema', 'input'] as const;

/**
 * Linear reports a rejected request in `errors[]` whatever the status — 200,
 * 400 and 401 all carry one — so the body decides the class and the status is
 * only a fallback for a response with no body to read.
 *
 * Every error is weighed, not just the first: a response whose first entry is a
 * bad id and whose second is an authentication failure is an authentication
 * failure, and saying "that project does not exist" would send the reader after
 * the wrong thing.
 */
function throwForGraphqlErrors(errors: readonly GraphqlError[]): never {
  const message = errors
    .map((error) => error.message ?? 'unknown error')
    .join('; ');
  const found = new Set(
    errors.map((error) =>
      faultOf(
        error.extensions?.code ?? '',
        error.extensions?.type?.toLowerCase() ?? ''
      )
    )
  );
  const fault = FAULT_ORDER.find((candidate) => found.has(candidate));

  switch (fault) {
    case 'ratelimited':
      throw new EnvironmentError(
        `linear rate-limited the request: ${message}`,
        {
          hint: 'wait for the rate-limit window to reset; the next refresh retries.',
        }
      );
    case 'auth':
      throw new EnvironmentError(`linear rejected the api key: ${message}`, {
        hint: `set ${LINEAR_TOKEN_VAR} to a key that can read the workspace.`,
      });
    // A field this module asks for that the schema does not have. No amount of
    // retrying or data-fixing clears it; someone edits the query.
    case 'schema':
      throw new DefinitionError(`linear refused the query: ${message}`, {
        hint: 'the query asks for something the Linear schema does not have; fix the query document in the dispatch Linear client.',
      });
    case 'input':
      throw new DataError(`linear rejected the query: ${message}`, {
        hint: 'the project, milestone, or ticket named does not exist on Linear, or the key cannot see it.',
      });
    default:
      throw new EnvironmentError(`linear returned an error: ${message}`, {
        hint: `check ${LINEAR_TOKEN_VAR} and https://linearstatus.com; the next refresh retries.`,
      });
  }
}

function throwForStatus(status: number): never {
  if (status === 401 || status === 403) {
    throw new EnvironmentError(
      `linear rejected the api key (HTTP ${String(status)})`,
      {hint: `set ${LINEAR_TOKEN_VAR} to a key that can read the workspace.`}
    );
  }
  throw new EnvironmentError(`linear answered HTTP ${String(status)}`, {
    hint: 'check https://linearstatus.com; the next refresh retries.',
  });
}

/**
 * `fetch` rejects with the abort reason itself, so a signal from
 * `AbortSignal.timeout` surfaces as a `TimeoutError` and a plain
 * `AbortController` as an `AbortError`. Both mean "we stopped it", which is
 * what separates the timeout from a connection that genuinely failed.
 */
function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

/**
 * A GraphQL executor bound to one endpoint and key.
 *
 * `fetch` is injected so a test drives the whole error-mapping path without a
 * socket, and every request carries a timeout: the drain seam calls this on
 * the server tick, where a hung connection would stall every other watch.
 */
export function createTransport(options: TransportOptions): GraphqlExecutor {
  const endpoint = options.endpoint ?? LINEAR_API_URL;
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const header = authorization(options.token);

  return async <TData,>(input: ExecuteInput): Promise<TData> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      input.signal === undefined
        ? timeout
        : AbortSignal.any([timeout, input.signal]);

    /** A cancellation the caller asked for is theirs; everything else is ours to name. */
    const rethrow = (error: unknown): never => {
      if (input.signal?.aborted === true) throw error;
      if (isAbort(error) && timeout.aborted) {
        throw new EnvironmentError(
          `linear did not answer within ${String(timeoutMs)}ms`,
          {
            hint: 'the next refresh retries; raise the timeout if it never does.',
            cause: error,
          }
        );
      }
      throw new EnvironmentError(
        `could not reach linear: ${error instanceof Error ? error.message : String(error)}`,
        {hint: 'check network access to api.linear.app.', cause: error}
      );
    };

    let response: Response;
    let text: string;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: header,
        },
        body: JSON.stringify({
          query: input.query,
          variables: input.variables ?? {},
        }),
        signal,
      });
      // The body is read inside the same guard as the request: aborting the
      // signal tears down the response stream too, so a timeout here arrives
      // as a failed read, not a failed fetch.
      text = await response.text();
    } catch (error) {
      return rethrow(error);
    }

    let body: GraphqlBody<TData> | null = null;
    try {
      body = JSON.parse(text) as GraphqlBody<TData>;
    } catch {
      // Left null: an unparseable body on an error status is better reported
      // as that status, and only an unparseable 200 is a broken payload.
    }

    if (body?.errors !== undefined && body.errors.length > 0) {
      throwForGraphqlErrors(body.errors);
    }
    if (!response.ok) {
      throwForStatus(response.status);
    }
    ensure(
      body !== null,
      () =>
        new EnvironmentError(
          'linear answered with something that is not JSON',
          {
            hint: 'a proxy is probably answering in its place; check the endpoint.',
          }
        )
    );
    ensure(
      body.data !== undefined && body.data !== null,
      () =>
        new EnvironmentError('linear answered with neither data nor errors', {
          hint: 'retry; if it persists, check https://linearstatus.com.',
        })
    );
    return body.data;
  };
}

/** Whether the environment can drive Linear directly, without deciding anything else. */
export function hasLinearToken(env: NodeJS.ProcessEnv): boolean {
  const token = env[LINEAR_TOKEN_VAR];
  return typeof token === 'string' && token.trim() !== '';
}

/** The key, or an `EnvironmentError` naming the variable that is missing. */
export function requireLinearToken(env: NodeJS.ProcessEnv): string {
  const token = env[LINEAR_TOKEN_VAR]?.trim() ?? '';
  ensure(
    token !== '',
    () =>
      new EnvironmentError(`${LINEAR_TOKEN_VAR} is not set`, {
        hint: `export ${LINEAR_TOKEN_VAR}=<linear api key> to let dispatch read Linear itself, or leave it unset to fetch through an agent session.`,
      })
  );
  return token;
}
