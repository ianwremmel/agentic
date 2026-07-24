import assert from 'node:assert/strict';
import {PassThrough, Readable} from 'node:stream';
import {describe, it} from 'node:test';

import {createLogger} from '../log/logger.mts';
import {METHOD_NOT_FOUND, PARSE_ERROR} from './protocol.mts';
import {
  CHANNEL_CAPABILITY,
  LATEST_PROTOCOL_VERSION,
  SERVER_NAME,
  serve,
} from './server.mts';

const VERSION = '1.2.3';

/** Logs go to their own sink here, as they go to stderr in production. */
function sinkLogger() {
  return createLogger({stream: new PassThrough(), level: 'debug'});
}

/**
 * Drive the server through an in-memory stream pair: write `lines` as the peer
 * would, and read back everything it framed onto stdout.
 */
async function exchange(lines: readonly string[]): Promise<string[]> {
  const input = Readable.from([lines.map((line) => `${line}\n`).join('')]);
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', (chunk: Buffer | string) => written.push(String(chunk)));

  await serve({input, output, log: sinkLogger(), version: VERSION});

  return written
    .join('')
    .split('\n')
    .filter((line) => line !== '');
}

function initialize(protocolVersion?: string): string {
  const params =
    protocolVersion === undefined
      ? '{}'
      : `{"protocolVersion":"${protocolVersion}"}`;
  return `{"jsonrpc":"2.0","id":1,"method":"initialize","params":${params}}`;
}

describe('serve — handshake', () => {
  it('answers initialize by advertising the channel capability', async () => {
    const [line, ...rest] = await exchange([
      initialize(LATEST_PROTOCOL_VERSION),
    ]);

    assert.deepEqual(rest, [], 'one request, one response');
    assert.deepEqual(JSON.parse(line ?? ''), {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {experimental: {[CHANNEL_CAPABILITY]: {}}},
        serverInfo: {name: SERVER_NAME, version: VERSION},
      },
    });
  });

  it('answers a revision it does not speak with the newest it does', async () => {
    const [line] = await exchange([initialize('1999-01-01')]);
    const {result} = JSON.parse(line ?? '') as {
      result: {protocolVersion: string};
    };

    assert.equal(result.protocolVersion, LATEST_PROTOCOL_VERSION);
  });

  it('answers a peer that names no revision at all', async () => {
    const [line] = await exchange([initialize()]);
    const {result} = JSON.parse(line ?? '') as {
      result: {protocolVersion: string};
    };

    assert.equal(result.protocolVersion, LATEST_PROTOCOL_VERSION);
  });

  it('says nothing back to notifications/initialized', async () => {
    const written = await exchange([
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    ]);

    assert.deepEqual(written, []);
  });

  it('answers ping, which either side may send at any time', async () => {
    const [line] = await exchange([
      '{"jsonrpc":"2.0","id":"p","method":"ping"}',
    ]);

    assert.deepEqual(JSON.parse(line ?? ''), {
      jsonrpc: '2.0',
      id: 'p',
      result: {},
    });
  });
});

describe('serve — messages it will not answer', () => {
  it('reports a method it does not implement, exposing no tools', async () => {
    const [line] = await exchange([
      '{"jsonrpc":"2.0","id":9,"method":"tools/list"}',
    ]);

    assert.deepEqual(JSON.parse(line ?? ''), {
      jsonrpc: '2.0',
      id: 9,
      error: {code: METHOD_NOT_FOUND, message: 'unknown method "tools/list"'},
    });
  });

  it('answers a malformed line with a parse error and no id', async () => {
    const [line, ...rest] = await exchange(['{"jsonrpc":"2.0",']);
    const response = JSON.parse(line ?? '') as {
      id: null;
      error: {code: number};
    };

    assert.deepEqual(rest, []);
    assert.equal(response.id, null);
    assert.equal(response.error.code, PARSE_ERROR);
  });

  it('never answers a notification, however unknown its method', async () => {
    const written = await exchange([
      '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}',
      '{"jsonrpc":"2.0","method":"who/knows"}',
    ]);

    assert.deepEqual(written, []);
  });

  it('never answers a response, which would bounce back and forth', async () => {
    const written = await exchange(['{"jsonrpc":"2.0","id":4,"result":{}}']);

    assert.deepEqual(written, []);
  });

  it('keeps serving after a message it refused', async () => {
    const written = await exchange([
      'not json at all',
      initialize(LATEST_PROTOCOL_VERSION),
    ]);

    assert.equal(written.length, 2, 'the refusal did not end the session');
    const handshake = JSON.parse(written[1] ?? '') as {id: number};
    assert.equal(handshake.id, 1, 'the handshake after it was still answered');
  });
});

describe('serve — lifetime', () => {
  it('returns when the peer closes the stream', async () => {
    // Resolving at all is the assertion: a server that kept reading would hang
    // the test rather than fail it.
    await exchange([initialize(LATEST_PROTOCOL_VERSION)]);
  });

  it('returns when the signal aborts, with the stream still open', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const controller = new AbortController();

    const running = serve({
      input,
      output,
      log: sinkLogger(),
      version: VERSION,
      signal: controller.signal,
    });
    controller.abort();

    await running;
    assert.equal(input.destroyed, false, 'the runner still owns the stream');
  });

  it('writes nothing but framed JSON to stdout', async () => {
    const written = await exchange([
      initialize(LATEST_PROTOCOL_VERSION),
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      'garbage',
      '{"jsonrpc":"2.0","id":2,"method":"resources/list"}',
    ]);

    for (const line of written) {
      const message = JSON.parse(line) as {jsonrpc: string};
      assert.equal(message.jsonrpc, '2.0');
    }
  });
});
