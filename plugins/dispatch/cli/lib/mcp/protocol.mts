/**
 * JSON-RPC 2.0 wire shapes, and the classification of one inbound line into
 * something the server can act on.
 *
 * The CLI ships with no runtime dependencies, so the MCP SDK is unavailable and
 * the protocol is written out here. Only the parts a push-only server needs are
 * modelled: it answers requests and receives notifications, and never issues a
 * request of its own.
 */

export const JSONRPC_VERSION = '2.0';

/** A JSON-RPC id. MCP narrows the spec's numbers to integers. */
export type JsonRpcId = string | number;

/** The JSON-RPC 2.0 codes this server produces. The -32000..-32099 implementation range is unused. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
}

/** A call that expects a response. */
export interface JsonRpcRequest {
  readonly kind: 'request';
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** A call that must never be answered — not even to say it was malformed. */
export interface JsonRpcNotification {
  readonly kind: 'notification';
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * A message the server must not answer and cannot act on: a response to a
 * request it never sent, or a notification it had to refuse. Answering either
 * would bounce off a peer applying the same rule, so both are dropped with a
 * reason worth logging.
 */
export interface JsonRpcIgnored {
  readonly kind: 'ignored';
  readonly reason: string;
}

/**
 * A line that is not a legal request, and that the peer is owed an answer to.
 * `id` is the one to answer on when the line carried a usable one, and `null` —
 * JSON-RPC's "no id" — when it did not.
 */
export interface JsonRpcMalformed {
  readonly kind: 'malformed';
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorBody;
}

export type IncomingMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcIgnored | JsonRpcMalformed;

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorBody;
}

export function successResponse(
  id: JsonRpcId,
  result: unknown
): JsonRpcSuccessResponse {
  return {jsonrpc: JSONRPC_VERSION, id, result};
}

export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string
): JsonRpcErrorResponse {
  return {jsonrpc: JSONRPC_VERSION, id, error: {code, message}};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The id as a call can be addressed by, or `null` where the value cannot name one. */
function readId(value: unknown): JsonRpcId | null {
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Classify one line of the stdio stream. Every failure mode is a value rather
 * than a throw: a peer that sends garbage must not be able to kill a server
 * whose lifetime is its session's.
 */
export function parseMessage(line: string): IncomingMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    // The only case where a request and a notification cannot be told apart, so
    // the only one answered blind. JSON-RPC's id for that answer is null.
    return {
      kind: 'malformed',
      id: null,
      error: {
        code: PARSE_ERROR,
        message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  if (!isRecord(decoded)) {
    // A batch — a JSON array — lands here too: this server negotiates only
    // revisions that dropped batching, so one is as unanswerable as a string.
    return {
      kind: 'malformed',
      id: null,
      error: {
        code: INVALID_REQUEST,
        message: 'a message must be a JSON object',
      },
    };
  }

  const method =
    typeof decoded.method === 'string' ? decoded.method : undefined;
  // A literal null id names no call, so it reads the same as no id at all.
  const addressed = 'id' in decoded && decoded.id !== null;
  const id = readId(decoded.id);

  // No method but an outcome: a response to a call this server never made.
  if (method === undefined && ('result' in decoded || 'error' in decoded)) {
    return {
      kind: 'ignored',
      reason: 'a response to a request this server never sent',
    };
  }

  /**
   * Refuse the message the only way JSON-RPC allows: a notification is dropped
   * silently, since a reply to one is illegal however wrong it was; anything
   * else is answered, on its own id where it named a usable one.
   */
  const refuse = (code: number, message: string): IncomingMessage =>
    !addressed && method !== undefined
      ? {kind: 'ignored', reason: message}
      : {kind: 'malformed', id, error: {code, message}};

  if (decoded.jsonrpc !== JSONRPC_VERSION) {
    return refuse(INVALID_REQUEST, `jsonrpc must be "${JSONRPC_VERSION}"`);
  }

  if (method === undefined) {
    return refuse(INVALID_REQUEST, 'a message must carry a string method');
  }

  // MCP passes arguments by name. Positional (array) params would have to be
  // mapped per method, and no method here takes them.
  if (decoded.params !== undefined && !isRecord(decoded.params)) {
    return refuse(
      INVALID_PARAMS,
      `params must be an object (method "${method}")`
    );
  }

  const params = isRecord(decoded.params) ? decoded.params : {};

  if (!addressed) {
    return {kind: 'notification', method, params};
  }

  if (id === null) {
    // Addressed, but by something no response can carry back. Dropping it would
    // leave the peer waiting for an answer that can never be routed.
    return {
      kind: 'malformed',
      id: null,
      error: {
        code: INVALID_REQUEST,
        message: 'id must be a string or an integer',
      },
    };
  }

  return {kind: 'request', id, method, params};
}
