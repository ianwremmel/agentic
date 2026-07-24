import assert from 'node:assert/strict';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {describe, it} from 'node:test';

import {pluginVersion} from '../lib/plugin-version.mts';
import {DISPATCH_BIN, logRecords, runDispatch} from '../../test-harness.mts';

/** Spawn the CLI the way a session runner does: stdio pipes, no terminal. */
function spawnServer(): ChildProcessWithoutNullStreams {
  return spawn(DISPATCH_BIN, ['mcp'], {
    env: {PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? ''},
  });
}

/** The next framed message the server writes, parsed. */
async function nextMessage(
  child: ChildProcessWithoutNullStreams
): Promise<Record<string, unknown>> {
  const reader = createInterface({input: child.stdout, crlfDelay: Infinity});
  try {
    for await (const line of reader) {
      if (line.trim() !== '') {
        return JSON.parse(line) as Record<string, unknown>;
      }
    }
  } finally {
    reader.close();
  }
  throw new Error('the server closed stdout without answering');
}

/** Exit code and signal, reported the way a shell would. */
async function exitOf(
  child: ChildProcessWithoutNullStreams
): Promise<{code: number | null; signal: NodeJS.Signals | null}> {
  const [code, signal] = (await once(child, 'close')) as [
    number | null,
    NodeJS.Signals | null,
  ];
  return {code, signal};
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {name: 'test-client', version: '0.0.0'},
  },
});

describe('dispatch mcp', () => {
  it('completes a handshake over real pipes and exits on stdin EOF', async () => {
    const child = spawnServer();
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    child.stdin.write(`${INITIALIZE}\n`);
    const response = await nextMessage(child);

    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {experimental: {'claude/channel': {}}},
        serverInfo: {name: 'dispatch', version: await pluginVersion()},
      },
    });

    child.stdin.end();
    const {code} = await exitOf(child);

    assert.equal(code, 0, 'the server exits with the peer that spawned it');
    assert.ok(
      logRecords(stderr.join('')).length > 0,
      'its logs go to stderr, where they cannot corrupt the protocol'
    );
  });

  it('exits cleanly on SIGTERM', async () => {
    const child = spawnServer();

    child.stdin.write(`${INITIALIZE}\n`);
    await nextMessage(child);
    child.kill('SIGTERM');

    const {code, signal} = await exitOf(child);
    assert.equal(signal, null, 'it handles the signal rather than dying of it');
    assert.equal(code, 0);
  });

  it('answers --help without starting a server', async () => {
    const {code, stdout} = await runDispatch(['mcp', '--help']);

    assert.equal(code, 0);
    assert.match(stdout, /^usage: dispatch mcp \[<subcommand>/mu);
    assert.match(stdout, /With no subcommand:/u);
  });

  it('rejects a subcommand it does not have', async () => {
    const {code, stderr} = await runDispatch(['mcp', 'status'], {input: ''});

    assert.equal(code, 2);
    assert.match(stderr, /unknown mcp subcommand "status"/u);
  });
});
