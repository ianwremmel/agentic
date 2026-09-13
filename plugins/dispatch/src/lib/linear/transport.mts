import {
  LinearClient as LinearSdk,
  LinearError,
  LinearGraphQLClient,
} from '@linear/sdk';

import {EnvironmentError} from '../errors/index.mts';
import {throwForLinearError} from './faults.mts';
import {LINEAR_TOKEN_VAR, resolveCredentials} from './token.mts';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

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
      ...resolveCredentials(options.token),
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
