import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable, Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {discover} from '../command/index.mts';
import {runMcpServer} from './mcp.mts';

const FIXTURES = new URL('../command/__fixtures__/commands/', import.meta.url);

function feed(messages: unknown[]): Readable {
  return Readable.from(messages.map((m) => `${JSON.stringify(m)}\n`));
}

function feedRaw(lines: string[]): Readable {
  return Readable.from(lines.map((l) => `${l}\n`));
}

const nullStream = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

interface RpcResult {
  protocolVersion?: string;
  capabilities?: {experimental?: Record<string, unknown>};
  tools?: {name: string}[];
  content?: {type: string; text: string}[];
  isError?: boolean;
}

interface RpcLine {
  jsonrpc: string;
  id?: number | string | null;
  result?: RpcResult;
  error?: {code: number; message: string};
}

async function serve(
  stdin: Readable,
  env?: NodeJS.ProcessEnv
): Promise<RpcLine[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-mcp-'));
  const resolved = {DISPATCH_DB: path.join(dir, 'graph.db'), ...env};
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  await runMcpServer({
    tree: await discover(FIXTURES),
    stdin,
    stdout,
    stderr: nullStream(),
    env: resolved,
  });
  return chunks
    .join('')
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as RpcLine);
}

describe('runMcpServer', () => {
  it('handshakes and lists generated tools', async () => {
    const res = await serve(
      feed([
        {jsonrpc: '2.0', id: 1, method: 'initialize', params: {}},
        {jsonrpc: '2.0', id: 2, method: 'tools/list'},
      ])
    );
    const [init, list] = res;
    assert.ok(init);
    assert.ok(list);
    assert.equal(init.result?.protocolVersion, '2025-06-18');
    assert.ok(list.result?.tools?.some((t) => t.name === 'store_get'));
  });

  it('runs a tool and returns its captured output', async () => {
    const res = await serve(
      feed([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {name: 'greet', arguments: {who: 'Ada'}},
        },
      ])
    );
    const [reply] = res.filter((line) => line.id !== undefined);
    assert.ok(reply);
    const content = reply.result?.content;
    assert.ok(content);
    assert.match(content[0]?.text ?? '', /hello Ada/);
    assert.equal(reply.result?.isError, undefined);
  });

  it('reports a command failure as an isError result, not a protocol error', async () => {
    const res = await serve(
      feed([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {name: 'math_add', arguments: {a: '2'}},
        },
      ])
    );
    const [reply] = res.filter((line) => line.id !== undefined);
    assert.ok(reply);
    assert.equal(reply.result?.isError, true);
    assert.equal(reply.error, undefined);
  });

  it('reports a missing env var as an isError result', async () => {
    const res = await serve(
      feed([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {name: 'needs-token', arguments: {}},
        },
      ])
    );
    const [reply] = res.filter((line) => line.id !== undefined);
    assert.ok(reply);
    assert.equal(reply.result?.isError, true);
    const content = reply.result.content;
    assert.ok(content);
    assert.match(content[0]?.text ?? '', /MY_TOKEN/);
  });

  it('rejects an unknown method with -32601', async () => {
    const res = await serve(feed([{jsonrpc: '2.0', id: 9, method: 'bogus'}]));
    const [reply] = res;
    assert.ok(reply);
    assert.equal(reply.error?.code, -32601);
  });

  it('rejects an unknown tool with -32602', async () => {
    const res = await serve(
      feed([
        {jsonrpc: '2.0', id: 9, method: 'tools/call', params: {name: 'nope'}},
      ])
    );
    const [reply] = res.filter((line) => line.id !== undefined);
    assert.ok(reply);
    assert.equal(reply.error?.code, -32602);
  });

  it('survives a malformed line and processes the next request', async () => {
    const res = await serve(
      feedRaw([
        'not json',
        JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}),
      ])
    );
    const [parseFailure, list] = res;
    assert.ok(parseFailure);
    assert.ok(list);
    assert.equal(parseFailure.error?.code, -32700);
    assert.ok(list.result?.tools);
  });

  it('never responds to a notification, even for an unhandled method', async () => {
    const res = await serve(
      feed([
        {jsonrpc: '2.0', method: 'notifications/cancelled'},
        {jsonrpc: '2.0', id: 1, method: 'tools/list'},
      ])
    );
    assert.equal(res.length, 1);
    const [reply] = res;
    assert.ok(reply);
    assert.equal(reply.id, 1);
    assert.ok(reply.result?.tools);
  });

  it('produces no response for notifications/initialized', async () => {
    const res = await serve(
      feed([{jsonrpc: '2.0', method: 'notifications/initialized'}])
    );
    assert.equal(res.length, 0);
  });

  it('advertises the channel capability in initialize', async () => {
    const res = await serve(
      feed([{jsonrpc: '2.0', id: 1, method: 'initialize', params: {}}])
    );
    const [init] = res;
    assert.ok(init);
    assert.ok(
      init.result?.capabilities?.experimental?.['claude/channel'] !== undefined
    );
  });
});
