import {readFile} from 'node:fs/promises';
import readline from 'node:readline';
import type {Readable, Writable} from 'node:stream';

import type {CommandNode} from '../command/index.mts';
import {createLogger, streamSink} from '../logger/index.mts';
import type {Logger} from '../logger/index.mts';
import {buildTools} from './tools.mts';
import type {BuiltTools} from './tools.mts';
import {callTool} from './dispatch.mts';
import {JsonRpcError} from '../errors/index.mts';
import {ChannelWriter} from './channel.mts';
import {drainInstructions} from './drain.mts';

const PROTOCOL_VERSION = '2025-06-18';

/**
 * The handshake reports the shipped plugin version, read from the manifest so
 * the two can never disagree. A missing or unreadable manifest (a stripped-down
 * install) degrades to 0.0.0 rather than failing the handshake.
 */
async function serverInfo(): Promise<{name: string; version: string}> {
  try {
    const manifest = new URL(
      '../../../.claude-plugin/plugin.json',
      import.meta.url
    );
    const parsed = JSON.parse(await readFile(manifest, 'utf8')) as {
      version?: unknown;
    };
    return {
      name: 'dispatch',
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    };
  } catch {
    return {name: 'dispatch', version: '0.0.0'};
  }
}

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
  readonly serverInfo: {name: string; version: string};
  readonly channel: ChannelWriter;
}

interface Handled {
  readonly response: unknown;
  readonly ranTool: boolean;
}

/**
 * Serve MCP over newline-delimited JSON-RPC 2.0 on stdin/stdout until stdin
 * closes. When `tick` is given, its `run` fires on the interval and after
 * every tool call — the scheduling heartbeat riding the same channel.
 */
export async function runMcpServer(opts: {
  tree: CommandNode;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
  tick?: {
    intervalMs: number;
    run: (channel: ChannelWriter) => Promise<void>;
  };
}): Promise<void> {
  const channel = new ChannelWriter((payload) => {
    opts.stdout.write(`${JSON.stringify(payload)}\n`);
  });

  const ctx: RequestContext = {
    tools: buildTools(opts.tree),
    env: opts.env,
    log: createLogger(streamSink(opts.stderr)),
    serverInfo: await serverInfo(),
    channel,
  };

  // Every tick entrypoint — the timer and the post-tool-call run — shares one
  // non-reentrancy guard: a tick requested while one runs coalesces into a
  // single follow-up rather than overlapping DB work.
  const tickState = {running: false, requested: false};
  const tickQuietly = async (): Promise<void> => {
    if (opts.tick === undefined) return;
    if (tickState.running) {
      tickState.requested = true;
      return;
    }
    tickState.running = true;
    try {
      do {
        tickState.requested = false;
        try {
          await opts.tick.run(channel);
        } catch (error) {
          ctx.log.error('scheduler tick failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the await above can re-enter tickQuietly, which sets `requested`; the analyzer cannot see that mutation
      } while (tickState.requested);
    } finally {
      tickState.running = false;
    }
  };

  const timer =
    opts.tick === undefined
      ? undefined
      : setInterval(() => {
          void tickQuietly();
        }, opts.tick.intervalMs);

  try {
    const rl = readline.createInterface({
      input: opts.stdin,
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (line.trim() === '') continue;
      const {response, ranTool} = await handleLine(line, ctx);
      if (response !== undefined)
        opts.stdout.write(`${JSON.stringify(response)}\n`);
      if (ranTool) {
        await drainQuietly(channel, ctx);
        await tickQuietly();
      }
    }
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

/**
 * A drain failure (an unwritable state dir, a locked file, a schema-version
 * mismatch after an upgrade) must not take the read loop down with it — the
 * graph is a rebuildable cache, and stdout is the JSON-RPC channel, so the
 * failure goes to stderr and the undelivered rows stay undelivered for the
 * next tool call to retry.
 */
async function drainQuietly(
  channel: ChannelWriter,
  ctx: RequestContext
): Promise<void> {
  try {
    await drainInstructions(channel, ctx.env);
  } catch (error) {
    ctx.log.error('channel drain failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleLine(line: string, ctx: RequestContext): Promise<Handled> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return {
      response: errorResponse(null, new JsonRpcError(-32700, 'parse error')),
      ranTool: false,
    };
  }

  const ranTool = request.method === 'tools/call';

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
    return {response: undefined, ranTool};
  }

  const id = request.id ?? null;
  try {
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      throw new JsonRpcError(-32600, 'invalid request');
    }
    const result = await dispatch(request.method, request.params ?? {}, ctx);
    return {response: {jsonrpc: '2.0', id, result}, ranTool};
  } catch (error) {
    if (error instanceof JsonRpcError) {
      return {response: errorResponse(id, error), ranTool};
    }
    // A non-JsonRpcError from a handler must not kill the read loop for
    // later lines, so it becomes an internal-error response instead of a
    // rethrow.
    return {
      response: errorResponse(id, new JsonRpcError(-32603, 'internal error')),
      ranTool,
    };
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
        capabilities: {tools: {}, experimental: {'claude/channel': {}}},
        serverInfo: ctx.serverInfo,
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
      return callTool(command, args, {
        env: ctx.env,
        log: ctx.log,
        channel: ctx.channel,
      });
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
