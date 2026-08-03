import assert from 'node:assert/strict';
import path from 'node:path';
import {describe, it} from 'node:test';

import {tempEnv} from '../src/lib/command/test-support.mts';
import {DISPATCH_MCP_BIN, fakeNodeDir, runDispatch} from '../test-harness.mts';

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {name: 'probe', version: '0'},
  },
})}\n`;

interface InitializeResponse {
  result?: {
    capabilities: {experimental: Record<string, unknown>};
    serverInfo: {name: string};
  };
}

describe('bin/dispatch-mcp', () => {
  // `.mcp.json` names this wrapper and passes it no environment, because
  // whether the MCP loader merges or replaces a server's env is unspecified.
  // The wrapper must therefore reach the `src` tree on its own.
  it('serves the MCP entry point with nothing set by its caller', async () => {
    const {code, stdout, stderr} = await runDispatch([], {
      bin: DISPATCH_MCP_BIN,
      env: await tempEnv(),
      input: INITIALIZE,
    });

    assert.equal(code, 0, stderr);
    const {result} = JSON.parse(stdout.trim()) as InitializeResponse;
    assert(result !== undefined, stdout);
    assert.equal(result.serverInfo.name, 'dispatch');
    assert.deepEqual(result.capabilities.experimental, {'claude/channel': {}});
  });

  it('goes through the node floor check rather than around it', async () => {
    const dir = await fakeNodeDir('v20.11.0');

    const {code, stdout, stderr} = await runDispatch([], {
      bin: DISPATCH_MCP_BIN,
      env: {PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`},
      input: INITIALIZE,
    });

    assert.equal(stdout, '', 'a rejected node must not serve the protocol');
    assert.notEqual(code, 0);
    assert.match(stderr, /too old/u);
  });
});
