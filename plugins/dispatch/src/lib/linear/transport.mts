import {DataError, EnvironmentError, ensure} from '../errors/index.mts';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';
export const LINEAR_TOKEN_VAR = 'LINEAR_API_KEY';

/** Long enough for a 250-issue page, short enough that a hung call cannot stall a server tick. */
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

/**
 * Linear takes a personal API key as the bare `Authorization` value and an
 * OAuth token as a `Bearer`. A caller that already wrote a scheme keeps it.
 */
export function authorization(token: string): string {
  if (token.includes(' ')) return token;
  return token.startsWith('lin_api_') ? token : `Bearer ${token}`;
}

/** Error types Linear reports for input it understood but could not honor. */
const INPUT_FAULTS = new Set([
  'invalid input',
  'entity not found',
  'feature not accessible',
  'usage error',
]);

/**
 * GraphQL answers a rejected request with HTTP 200 and an `errors` array, so
 * the body — not the status — decides. Split them the way the taxonomy does:
 * a fault in what we asked for is the caller's data to fix, anything else is
 * the environment's.
 */
function throwForGraphqlErrors(errors: readonly GraphqlError[]): never {
  const message = errors
    .map((error) => error.message ?? 'unknown error')
    .join('; ');
  const type = errors[0]?.extensions?.type?.toLowerCase() ?? '';
  if (INPUT_FAULTS.has(type)) {
    throw new DataError(`linear rejected the query: ${message}`, {
      hint: 'the project, milestone, or ticket named does not exist on Linear, or the key cannot see it.',
    });
  }
  if (type === 'authentication error') {
    throw new EnvironmentError(`linear rejected the api key: ${message}`, {
      hint: `set ${LINEAR_TOKEN_VAR} to a key that can read the workspace.`,
    });
  }
  throw new EnvironmentError(`linear returned an error: ${message}`, {
    hint: "usually transient on Linear's side; the next refresh retries.",
  });
}

function throwForStatus(status: number, retryAfter: string | null): never {
  if (status === 401 || status === 403) {
    throw new EnvironmentError(
      `linear rejected the api key (HTTP ${String(status)})`,
      {
        hint: `set ${LINEAR_TOKEN_VAR} to a key that can read the workspace.`,
      }
    );
  }
  if (status === 429) {
    throw new EnvironmentError('linear rate-limited the request (HTTP 429)', {
      hint:
        retryAfter === null
          ? 'wait for the rate-limit window to reset; the next refresh retries.'
          : `wait ${retryAfter}s; the next refresh retries.`,
    });
  }
  if (status === 400) {
    throw new DataError('linear could not parse the query (HTTP 400)', {
      hint: 'the query or its variables are malformed; this is a bug in the dispatch Linear client.',
    });
  }
  throw new EnvironmentError(`linear answered HTTP ${String(status)}`, {
    hint: 'check https://linearstatus.com; the next refresh retries.',
  });
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

    let response: Response;
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
    } catch (error) {
      if (timeout.aborted) {
        throw new EnvironmentError(
          `linear did not answer within ${String(timeoutMs)}ms`,
          {
            hint: 'the next refresh retries; raise the timeout if it never does.',
          }
        );
      }
      throw new EnvironmentError(
        `could not reach linear: ${error instanceof Error ? error.message : String(error)}`,
        {hint: 'check network access to api.linear.app.', cause: error}
      );
    }

    if (!response.ok) {
      throwForStatus(response.status, response.headers.get('retry-after'));
    }

    let body: GraphqlBody<TData>;
    try {
      body = (await response.json()) as GraphqlBody<TData>;
    } catch (error) {
      throw new EnvironmentError(
        'linear answered with something that is not JSON',
        {
          hint: 'a proxy is probably answering in its place; check the endpoint.',
          cause: error,
        }
      );
    }

    if (body.errors !== undefined && body.errors.length > 0) {
      throwForGraphqlErrors(body.errors);
    }
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
