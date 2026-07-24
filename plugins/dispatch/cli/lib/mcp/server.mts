import type {Writable} from 'node:stream';

import type {Logger} from '../log/logger.mts';
import {readMessages, writeMessage} from './framing.mts';
import {
  errorResponse,
  INTERNAL_ERROR,
  METHOD_NOT_FOUND,
  parseMessage,
  successResponse,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcSuccessResponse,
} from './protocol.mts';

/**
 * The channel server's transport: it reads JSON-RPC from the peer that spawned
 * it, answers the handshake, and returns when that peer goes away.
 *
 * It exposes no MCP tools. The session steers the server by writing the shared
 * graph database through ordinary `dispatch` commands, so nothing here has to
 * be called for the server to be correct.
 */

/** The MCP `serverInfo` name. What the runner labels our events with is the runner's own business. */
export const SERVER_NAME = 'dispatch';

/**
 * MCP protocol revisions this server answers with, newest first. It uses only
 * base-protocol features — the handshake and notifications — so support is a
 * question of what the peer will accept back, not of feature gating. Claude Code
 * 2.1.219 asks for `2025-11-25`, and accepts an older revision in the answer.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * The capability that makes this an event channel rather than an ordinary MCP
 * server: the runner registers a notification listener only when it is present.
 */
export const CHANNEL_CAPABILITY = 'claude/channel';

export interface ServeOptions {
  /** The peer's requests. In production, the process's stdin. */
  readonly input: NodeJS.ReadableStream;
  /** Framed JSON only — the peer parses every line, so nothing else may go here. */
  readonly output: Writable;
  /** Writes to stderr in production, which is why logging cannot corrupt the stream. */
  readonly log: Logger;
  /** The `serverInfo` version reported in the handshake. */
  readonly version: string;
  /** Aborting shuts the server down as cleanly as an end-of-stream does. */
  readonly signal?: AbortSignal;
}

interface RequestContext {
  readonly params: Readonly<Record<string, unknown>>;
  readonly version: string;
  readonly log: Logger;
}

type Handler = (context: RequestContext) => unknown;

/**
 * The methods this server answers. Anything absent is a `method not found`,
 * which is the honest answer for a server that exposes no tools.
 */
const HANDLERS = new Map<string, Handler>([
  ['initialize', initialize],
  // Part of MCP's base protocol: either side may check that the other is alive.
  ['ping', () => ({})],
]);

async function initialize({
  params,
  version,
  log,
}: RequestContext): Promise<unknown> {
  const protocolVersion = negotiateProtocolVersion(params.protocolVersion);

  // Which runner attached, and on which revision, is the first thing to want
  // when its events do not arrive: a refused channel looks like an ordinary
  // handshake from here.
  await log.info('peer connected', {
    protocol: protocolVersion,
    requested: String(params.protocolVersion),
    client: describeClient(params.clientInfo),
  });

  return {
    protocolVersion,
    capabilities: {experimental: {[CHANNEL_CAPABILITY]: {}}},
    serverInfo: {name: SERVER_NAME, version},
  };
}

function describeClient(clientInfo: unknown): string {
  if (typeof clientInfo !== 'object' || clientInfo === null) return 'unnamed';
  const {name, version} = clientInfo as {name?: unknown; version?: unknown};
  return `${typeof name === 'string' ? name : 'unnamed'}/${typeof version === 'string' ? version : 'unversioned'}`;
}

/**
 * Answer the peer until it closes the stream (or `signal` aborts), then return.
 *
 * Resolving rather than exiting the process keeps the transport testable
 * against an in-memory stream pair and leaves process lifetime to the command.
 */
export async function serve({
  input,
  output,
  log,
  version,
  signal,
}: ServeOptions): Promise<void> {
  await log.info('channel server started', {
    protocol: LATEST_PROTOCOL_VERSION,
    version,
  });

  // The peer's `notifications/initialized` closes the handshake. Nothing may be
  // pushed to the session before it lands.
  let initialized = false;

  const options = signal === undefined ? {} : {signal};
  for await (const line of readMessages(input, options)) {
    const message = parseMessage(line);

    switch (message.kind) {
      case 'request':
        await writeMessage(
          output,
          await respond(message.id, message.method, {
            params: message.params,
            version,
            log,
          })
        );
        break;
      case 'notification':
        if (message.method === 'notifications/initialized') {
          initialized = true;
          await log.info('handshake complete');
        } else {
          await log.debug('ignoring notification', {method: message.method});
        }
        break;
      case 'ignored':
        await log.debug('ignoring message', {reason: message.reason});
        break;
      case 'malformed':
        await log.warn('rejecting message', {
          code: message.error.code,
          detail: message.error.message,
        });
        await writeMessage(
          output,
          errorResponse(message.id, message.error.code, message.error.message)
        );
        break;
    }
  }

  await log.info('channel server stopped', {initialized});
}

/**
 * Run one request handler, turning a throw into an error response. A handler
 * that fails costs the peer one call, not the session's whole channel.
 */
async function respond(
  id: JsonRpcId,
  method: string,
  context: RequestContext
): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse> {
  const handler = HANDLERS.get(method);
  if (handler === undefined) {
    return errorResponse(id, METHOD_NOT_FOUND, `unknown method "${method}"`);
  }

  try {
    return successResponse(id, await handler(context));
  } catch (error) {
    return errorResponse(
      id,
      INTERNAL_ERROR,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Echo the peer's revision when this server speaks it, else name the newest one
 * it does speak and let the peer decide — MCP's negotiation rule.
 */
function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}
