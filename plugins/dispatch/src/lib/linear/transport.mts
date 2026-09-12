import {
  LinearClient as LinearSdk,
  LinearError,
  LinearErrorType,
  LinearGraphQLClient,
} from '@linear/sdk';

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
  /** Must be https, or a localhost url; the SDK refuses anything else. */
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

const BEARER = /^Bearer\s+/iu;

/**
 * Which credential slot the token goes in. The SDK sends an `apiKey` bare and
 * prefixes an `accessToken` with `Bearer`, which is the distinction Linear's
 * API draws — a personal key with a `Bearer` prefix is answered with HTTP 400.
 * `LINEAR_API_KEY` can hold either kind, so the `lin_api_` prefix Linear puts
 * on a personal key decides. Either way the token is handed over bare: the
 * SDK's own prefix check is case-sensitive against `Bearer `, so passing one
 * written `bearer x` straight through would be sent `Bearer bearer x`.
 */
export function credentials(
  token: string
): {apiKey: string} | {accessToken: string} {
  const bare = token.trim().replace(BEARER, '');
  return bare.startsWith('lin_api_') ? {apiKey: bare} : {accessToken: bare};
}

type Fault =
  'ratelimited' | 'auth' | 'schema' | 'input' | 'empty' | 'garbled' | 'remote';

/**
 * `extensions.code` names the fault on its own. The SDK reads only the sibling
 * `extensions.type`, which is prose that has changed before, so the code is
 * read here from the payload the SDK kept and the parsed type is the fallback
 * for an error carrying no code.
 */
const BY_CODE = new Map<string, Fault>([
  ['RATELIMITED', 'ratelimited'],
  ['AUTHENTICATION_ERROR', 'auth'],
  ['GRAPHQL_VALIDATION_FAILED', 'schema'],
  ['INPUT_ERROR', 'input'],
]);

const BY_TYPE = new Map<LinearErrorType, Fault>([
  [LinearErrorType.Ratelimited, 'ratelimited'],
  [LinearErrorType.UsageLimitExceeded, 'ratelimited'],
  [LinearErrorType.AuthenticationError, 'auth'],
  [LinearErrorType.Forbidden, 'auth'],
  [LinearErrorType.FeatureNotAccessible, 'auth'],
  [LinearErrorType.InvalidInput, 'input'],
  [LinearErrorType.UserError, 'input'],
]);
// `graphql error` is deliberately absent. It is the label Linear puts on
// anything raised in the GraphQL layer, and the fault it maps to is terminal —
// nothing retries past it — so only `GRAPHQL_VALIDATION_FAILED`, which names a
// query the schema will refuse every time, takes that route. Verified against
// the live API that a validation failure carries the code.

/** Most explanatory first: the one worth telling the caller about. */
const FAULT_ORDER = ['ratelimited', 'auth', 'schema', 'input'] as const;

/** `extensions.code`, which the SDK's own typings do not name. */
interface RawGraphqlError {
  readonly extensions?: {readonly code?: string};
}

/** Whether the SDK had a body it could not read as JSON, which it keeps as text. */
function answeredWithText(error: LinearError): boolean {
  return typeof error.raw?.response?.error === 'string';
}

/**
 * The payload as Linear sent it, kept by the SDK alongside its parse. Entries
 * line up with `error.errors` one for one, which is what lets a code and a
 * parsed type be read for the same error.
 */
function rawErrors(error: LinearError): readonly RawGraphqlError[] {
  const raw: unknown = error.raw?.response?.errors;
  return Array.isArray(raw) ? (raw as RawGraphqlError[]) : [];
}

/**
 * What a rejected request is, weighing every error Linear listed rather than
 * the first. The SDK types itself from the first entry alone, so a response
 * whose first error is a bad id and whose second is an authentication failure
 * would arrive as the bad id and send the reader after the wrong thing.
 */
function weigh(error: LinearError): Fault {
  const parsed = error.errors ?? [];
  if (parsed.length === 0) return forAnswer(error);
  const raw = rawErrors(error);
  const found = new Set(
    parsed.map((entry, index) => {
      const code = raw[index]?.extensions?.code ?? '';
      return BY_CODE.get(code) ?? BY_TYPE.get(entry.type) ?? 'remote';
    })
  );
  return FAULT_ORDER.find((candidate) => found.has(candidate)) ?? 'remote';
}

/**
 * A rejection with nothing in `errors[]` to read, which leaves the status and
 * the body. The SDK reads any bare 4xx as an authentication failure; only the
 * two statuses that mean that are taken as such here, or a bad request would
 * send the reader off to rotate a key that works.
 */
function forAnswer(error: LinearError): Fault {
  const status = error.status;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'ratelimited';
  if (status !== undefined && status >= 200 && status < 300) {
    // A success that is not a GraphQL answer at all is someone else answering;
    // one that is, but carries neither half, is Linear answering nothing.
    return answeredWithText(error) ? 'garbled' : 'empty';
  }
  return 'remote';
}

/**
 * Every message Linear sent, not the first. The SDK builds `error.message` from
 * `errors[0]` alone, so on the response the classification above exists for —
 * a bad id followed by an authentication failure — the text would name the one
 * the class does not.
 */
function messageOf(error: LinearError): string {
  const messages = (error.errors ?? [])
    .map((entry) => entry.message)
    .filter((message) => message !== '');
  return messages.length > 0 ? messages.join('; ') : error.message;
}

/** A rejection Linear explained, rethrown on the taxonomy with what to do about it. */
function throwForLinearError(error: LinearError): never {
  const message = messageOf(error);
  switch (weigh(error)) {
    case 'ratelimited':
      throw new EnvironmentError(
        `linear rate-limited the request: ${message}`,
        {
          hint: 'wait for the rate-limit window to reset; the next refresh retries.',
          cause: error,
        }
      );
    case 'auth':
      throw new EnvironmentError(`linear rejected the api key: ${message}`, {
        hint: `set ${LINEAR_TOKEN_VAR} to a key that can read the workspace.`,
        cause: error,
      });
    // A field this module asks for that the schema does not have. No amount of
    // retrying or data-fixing clears it; someone edits the query.
    case 'schema':
      throw new DefinitionError(`linear refused the query: ${message}`, {
        hint: 'the query asks for something the Linear schema does not have; fix the query document in the dispatch Linear client.',
        cause: error,
      });
    case 'input':
      throw new DataError(`linear rejected the query: ${message}`, {
        hint: 'the project, milestone, or ticket named does not exist on Linear, or the key cannot see it.',
        cause: error,
      });
    case 'empty':
      throw new EnvironmentError(
        'linear answered with neither data nor errors',
        {
          hint: 'retry; if it persists, check https://linearstatus.com.',
          cause: error,
        }
      );
    case 'garbled':
      throw new EnvironmentError(
        `linear answered with something that is not a GraphQL response: ${message}`,
        {
          hint: 'a proxy is probably answering in its place; check the endpoint.',
          cause: error,
        }
      );
    default:
      throw new EnvironmentError(`linear returned an error: ${message}`, {
        hint: 'check https://linearstatus.com; the next refresh retries.',
        cause: error,
      });
  }
}

/**
 * Whether a rejection is an abort rather than a connection that genuinely
 * failed. `fetch` rejects with the signal's reason, which for a plain
 * `AbortController` is an `AbortError`; `TimeoutError` is here because a
 * caller's own signal may come from `AbortSignal.timeout`.
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
 * The SDK owns the protocol — the request, the `errors[]` a rejection carries
 * whatever its HTTP status, and the class it lands on. What is left here is
 * policy the SDK has no opinion on: every request carries a timeout, because
 * the drain seam calls this on the server tick where a hung connection would
 * stall every other watch, and every failure it raises is restated on the
 * dispatch taxonomy so the agent reading it is told what to do.
 */
export function createTransport(options: TransportOptions): GraphqlExecutor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Built once, for the authorization header the SDK derives from the
  // credential slot; a blank token or a rejected endpoint fails here rather
  // than on the first read, and as a taxonomy error rather than the SDK's.
  let parsed;
  try {
    parsed = new LinearSdk({
      ...credentials(options.token),
      apiUrl: options.endpoint ?? LINEAR_API_URL,
    }).options;
  } catch (error) {
    throw new EnvironmentError(
      `linear client options were refused: ${error instanceof Error ? error.message : String(error)}`,
      {
        hint: `set ${LINEAR_TOKEN_VAR} to a non-blank key; a custom endpoint must be an https url.`,
        cause: error,
      }
    );
  }
  const {apiUrl, ...init} = parsed;

  return async <TData,>(input: ExecuteInput): Promise<TData> => {
    // A cleared timer rather than `AbortSignal.timeout`, whose signal stays
    // live for the whole window however fast the request finished. A walk is
    // one of these per page, so a scan would hold a thousand of them.
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort();
    }, timeoutMs);
    timer.unref();
    const signal =
      input.signal === undefined
        ? timeout.signal
        : AbortSignal.any([timeout.signal, input.signal]);

    // The client fixes its request options at construction and the signal is
    // per request, so it is rebuilt per request. It holds a url and headers and
    // opens nothing, which is what makes that affordable.
    const client = new LinearGraphQLClient(apiUrl, {...init, signal});

    let answer;
    try {
      answer = await client.rawRequest<TData, Record<string, unknown>>(
        input.query,
        input.variables ?? {}
      );
    } catch (error) {
      // A cancellation the caller asked for is theirs, and `fetch` rejects with
      // the signal's reason, so the reason itself is what identifies one. The
      // caller's reason can be any value — an abort carrying a plain `Error`
      // is still their abort — and asking only whether their signal fired
      // would hand back a rejection Linear explained, unclassified, whenever
      // they happened to cancel in the same turn.
      if (input.signal?.aborted === true && error === input.signal.reason) {
        throw error;
      }
      if (isAbort(error) && timeout.signal.aborted) {
        throw new EnvironmentError(
          `linear did not answer within ${String(timeoutMs)}ms`,
          {
            hint: 'the next refresh retries; raise the timeout if it never does.',
            cause: error,
          }
        );
      }
      if (error instanceof LinearError) throwForLinearError(error);
      // Either the connection failed or something answered in Linear's place
      // with a body the SDK could not read. Both are the endpoint, not the data.
      throw new EnvironmentError(
        `could not read an answer from linear: ${error instanceof Error ? error.message : String(error)}`,
        {
          hint: 'check network access to api.linear.app and that nothing is answering in its place; the next refresh retries.',
          cause: error,
        }
      );
    } finally {
      clearTimeout(timer);
    }

    // `rawRequest` rejects rather than answer without data — a 2xx carrying
    // neither is thrown above and classified `empty` — so the optional here is
    // the shape of its return type, not a case that reaches this line.
    return answer.data as TData;
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
