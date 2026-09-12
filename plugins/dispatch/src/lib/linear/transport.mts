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
  readonly signal?: AbortSignal | undefined;
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

/** The envelope as it arrives: a parsed object whose fields are still unknown. */
interface GraphqlEnvelope {
  readonly data?: unknown;
  readonly errors?: unknown;
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

type Fault = 'ratelimited' | 'auth' | 'schema' | 'input' | 'unknown';

const BY_CODE = new Map<string, Fault>([
  ['RATELIMITED', 'ratelimited'],
  ['AUTHENTICATION_ERROR', 'auth'],
  ['GRAPHQL_VALIDATION_FAILED', 'schema'],
  ['INPUT_ERROR', 'input'],
]);

const BY_TYPE = new Map<string, Fault>([
  ['ratelimited', 'ratelimited'],
  ['authentication error', 'auth'],
  ['graphql error', 'schema'],
  ['invalid input', 'input'],
]);

/**
 * What one Linear error is. `code` decides on its own; `extensions.type` is
 * prose that has changed before, so it is read only where the code says
 * nothing. An error carrying both is classified by its code, or the two
 * disagreeing would send the reader after whichever the prose named.
 */
function faultOf(code: string, type: string): Fault {
  return BY_CODE.get(code) ?? BY_TYPE.get(type) ?? 'unknown';
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

/** A GraphQL response is a JSON object; a bare literal or a list is not one. */
function envelopeOf(payload: unknown): GraphqlEnvelope | null {
  return typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
    ? payload
    : null;
}

/**
 * The envelope's `errors`, checked rather than trusted: the response is parsed
 * JSON, so `errors` can be any shape at all, and reading `.length` off the
 * wrong one would crash past the taxonomy instead of reporting the bad answer.
 * Entries that are not objects carry nothing to classify and are dropped.
 */
function errorsOf(raw: unknown): readonly GraphqlError[] {
  ensure(
    Array.isArray(raw),
    () =>
      new EnvironmentError(
        'linear answered with an `errors` field that is not a list',
        {
          hint: 'a proxy is probably answering in its place; check the endpoint.',
        }
      )
  );
  return raw.filter(
    (entry): entry is GraphqlError =>
      typeof entry === 'object' && entry !== null
  );
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

    let payload: unknown;
    let json = true;
    try {
      payload = JSON.parse(text);
    } catch {
      // Left unparsed: an unreadable body on an error status is better reported
      // as that status, and only an unreadable 200 is a broken payload.
      json = false;
    }
    const envelope = json ? envelopeOf(payload) : null;

    const errors = envelope?.errors;
    if (errors !== undefined) {
      const classifiable = errorsOf(errors);
      if (classifiable.length > 0) throwForGraphqlErrors(classifiable);
    }
    if (!response.ok) {
      throwForStatus(response.status);
    }
    ensure(
      envelope !== null,
      () =>
        new EnvironmentError(
          json
            ? 'linear answered with JSON that is not a GraphQL response'
            : 'linear answered with something that is not JSON',
          {
            hint: 'a proxy is probably answering in its place; check the endpoint.',
          }
        )
    );
    const data = envelope.data;
    ensure(
      data !== undefined && data !== null,
      () =>
        new EnvironmentError('linear answered with neither data nor errors', {
          hint: 'retry; if it persists, check https://linearstatus.com.',
        })
    );
    return data as TData;
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
