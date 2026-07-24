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

/** A JSON-RPC id. `null` is legal on the wire but names no call, so it is read as absent. */
export type JsonRpcId = string | number;

/** The standard JSON-RPC 2.0 codes. The -32000..-32099 implementation range is unused. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
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

/** A call that must never be answered — not even with an error. */
export interface JsonRpcNotification {
  readonly kind: 'notification';
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * A well-formed message the server has no business answering: a response to a
 * request it never sent. Answering one would bounce back off a peer applying
 * the same rule, so it is dropped with a reason worth logging.
 */
export interface JsonRpcIgnored {
  readonly kind: 'ignored';
  readonly reason: string;
}

/**
 * A line that is not a legal request or notification. `id` is the one to answer
 * on when the line carried a usable one, and `null` — JSON-RPC's "no id" — when
 * it did not.
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

/** The id a malformed message can still be answered on, if it carried one at all. */
function readId(value: unknown): JsonRpcId | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function malformed(id: JsonRpcId | null, message: string): JsonRpcMalformed {
  return {kind: 'malformed', id, error: {code: INVALID_REQUEST, message}};
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
    return malformed(null, 'a message must be a JSON object');
  }

  const id = readId(decoded.id);

  if (decoded.jsonrpc !== JSONRPC_VERSION) {
    return malformed(id, `jsonrpc must be "${JSONRPC_VERSION}"`);
  }

  if (typeof decoded.method !== 'string') {
    // No method and an id means this is a response to a call we never made:
    // this server only ever sends notifications.
    if (id !== null) {
      return {
        kind: 'ignored',
        reason: 'a response to a request this server never sent',
      };
    }
    return malformed(null, 'a message must carry a string method');
  }

  const {method} = decoded;

  // MCP passes arguments by name. Positional (array) params would have to be
  // mapped per method, and no method here takes them.
  if (decoded.params !== undefined && !isRecord(decoded.params)) {
    return malformed(id, `params must be an object (method "${method}")`);
  }

  const params = isRecord(decoded.params) ? decoded.params : {};

  return id === null
    ? {kind: 'notification', method, params}
    : {kind: 'request', id, method, params};
}
