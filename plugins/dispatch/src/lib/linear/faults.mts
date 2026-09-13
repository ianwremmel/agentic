import type {LinearError} from '@linear/sdk';
import {LinearErrorType} from '@linear/sdk';

import {
  DataError,
  DefinitionError,
  EnvironmentError,
} from '../errors/index.mts';
import {LINEAR_TOKEN_VAR} from './token.mts';

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
function hasTextBody(error: LinearError): boolean {
  return typeof error.raw?.response?.error === 'string';
}

/**
 * The payload as Linear sent it, kept by the SDK alongside its parse. Entries
 * line up with `error.errors` one for one, which is what lets a code and a
 * parsed type be read for the same error.
 */
function readRawErrors(error: LinearError): readonly RawGraphqlError[] {
  const raw: unknown = error.raw?.response?.errors;
  return Array.isArray(raw) ? (raw as RawGraphqlError[]) : [];
}

/**
 * A rejection with nothing in `errors[]` to read, which leaves the status and
 * the body. The SDK reads any bare 4xx as an authentication failure; only the
 * two statuses that mean that are taken as such here, or a bad request would
 * send the reader off to rotate a key that works.
 */
function classifyAnswer(error: LinearError): Fault {
  const status = error.status;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'ratelimited';
  if (status !== undefined && status >= 200 && status < 300) {
    // A success that is not a GraphQL answer at all is someone else answering;
    // one that is, but carries neither half, is Linear answering nothing.
    return hasTextBody(error) ? 'garbled' : 'empty';
  }
  return 'remote';
}

/**
 * What a rejected request is, weighing every error Linear listed rather than
 * the first. The SDK types itself from the first entry alone, so a response
 * whose first error is a bad id and whose second is an authentication failure
 * would arrive as the bad id and send the reader after the wrong thing.
 */
function classifyFault(error: LinearError): Fault {
  const parsed = error.errors ?? [];
  if (parsed.length === 0) return classifyAnswer(error);
  const raw = readRawErrors(error);
  const found = new Set(
    parsed.map((entry, index) => {
      const code = raw[index]?.extensions?.code ?? '';
      return BY_CODE.get(code) ?? BY_TYPE.get(entry.type) ?? 'remote';
    })
  );
  return FAULT_ORDER.find((candidate) => found.has(candidate)) ?? 'remote';
}

/**
 * Every message Linear sent, not the first. The SDK builds `error.message` from
 * `errors[0]` alone, so on the response the classification above exists for —
 * a bad id followed by an authentication failure — the text would name the one
 * the class does not.
 */
function joinMessages(error: LinearError): string {
  const messages = (error.errors ?? [])
    .map((entry) => entry.message)
    .filter((message) => message !== '');
  return messages.length > 0 ? messages.join('; ') : error.message;
}

/** A rejection Linear explained, rethrown on the taxonomy with what to do about it. */
export function throwForLinearError(error: LinearError): never {
  const message = joinMessages(error);
  switch (classifyFault(error)) {
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
