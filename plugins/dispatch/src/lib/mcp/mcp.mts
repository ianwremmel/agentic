import readline from 'node:readline';
import type {Readable, Writable} from 'node:stream';

import type {CommandNode} from '../command/index.mts';
import {createLogger} from '../logger/index.mts';
import type {CoreLogger, Logger} from '../logger/index.mts';
import {buildTools} from './tools.mts';
import type {BuiltTools} from './tools.mts';
import {callTool} from './dispatch.mts';
import {JsonRpcError} from './json-rpc-error.mts';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = {name: 'dispatch', version: '1.0.0'};
const LEVELS = ['error', 'warn', 'info', 'debug', 'trace', 'log'] as const;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface RequestContext {
  readonly tools: BuiltTools;
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
}

/** Serve MCP over newline-delimited JSON-RPC 2.0 on stdin/stdout until stdin closes. */
export async function runMcpServer(opts: {
  tree: CommandNode;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const ctx: RequestContext = {
    tools: buildTools(opts.tree),
    env: opts.env,
    log: createLogger(stderrSink(opts.stderr)),
  };

  const rl = readline.createInterface({input: opts.stdin, crlfDelay: Infinity});
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const response = await handleLine(line, ctx);
    if (response !== undefined)
      opts.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

async function handleLine(line: string, ctx: RequestContext): Promise<unknown> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return errorResponse(null, new JsonRpcError(-32700, 'parse error'));
  }

  // A notification is defined by the absence of `id`, not by the method it
  // names — an explicit `null` id is still a request per the current
  // behavior below.
  const isNotification = request.id === undefined;

  if (isNotification) {
    // Never reply to a notification, regardless of how dispatch fares.
    try {
      if (request.jsonrpc === '2.0' && typeof request.method === 'string') {
        await dispatch(request.method, request.params ?? {}, ctx);
      }
    } catch {
      // swallow: notifications get no response, even on failure
    }
    return undefined;
  }

  const id = request.id ?? null;
  try {
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      throw new JsonRpcError(-32600, 'invalid request');
    }
    const result = await dispatch(request.method, request.params ?? {}, ctx);
    return {jsonrpc: '2.0', id, result};
  } catch (error) {
    if (error instanceof JsonRpcError) return errorResponse(id, error);
    // A non-JsonRpcError from a handler must not kill the read loop for
    // later lines, so it becomes an internal-error response instead of a
    // rethrow.
    return errorResponse(id, new JsonRpcError(-32603, 'internal error'));
  }
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  ctx: RequestContext
): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {tools: {}},
        serverInfo: SERVER_INFO,
      };
    case 'notifications/initialized':
      return undefined;
    case 'tools/list':
      return {tools: ctx.tools.defs};
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') {
        throw new JsonRpcError(-32602, 'invalid params: name is required');
      }
      const command = ctx.tools.byName.get(name);
      if (command === undefined) {
        throw new JsonRpcError(-32602, `unknown tool: ${name}`);
      }
      const args =
        (params.arguments as Record<string, unknown> | undefined) ?? {};
      return callTool(command, args, {env: ctx.env, log: ctx.log});
    }
    default:
      throw new JsonRpcError(-32601, `method not found: ${method}`);
  }
}

function errorResponse(
  id: string | number | null,
  error: JsonRpcError
): unknown {
  return {
    jsonrpc: '2.0',
    id,
    error: {code: error.code, message: error.message},
  };
}

/** A logger sink that writes each message as a line to a stream (stderr). */
function stderrSink(stderr: Writable): CoreLogger {
  const write = (message: string, meta?: Record<string, unknown>) => {
    stderr.write(
      meta === undefined
        ? `${message}\n`
        : `${message} ${JSON.stringify(meta)}\n`
    );
  };
  const sink = {} as CoreLogger;
  for (const level of LEVELS) sink[level] = write;
  return sink;
}
