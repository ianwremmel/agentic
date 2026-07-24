import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  errorResponse,
  INVALID_PARAMS,
  INVALID_REQUEST,
  PARSE_ERROR,
  parseMessage,
  successResponse,
  type JsonRpcMalformed,
} from './protocol.mts';

/** Parse a line the server must refuse, and hand back the refusal to assert on. */
function refusal(line: string): JsonRpcMalformed {
  const message = parseMessage(line);
  assert.ok(
    message.kind === 'malformed',
    `expected ${line} to be refused, got ${message.kind}`
  );
  return message;
}

describe('parseMessage', () => {
  it('reads a call with an id as a request', () => {
    const message = parseMessage(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
    );

    assert.deepEqual(message, {
      kind: 'request',
      id: 1,
      method: 'initialize',
      params: {protocolVersion: '2025-06-18'},
    });
  });

  it('reads a call with no id as a notification', () => {
    const message = parseMessage(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    );

    assert.deepEqual(message, {
      kind: 'notification',
      method: 'notifications/initialized',
      params: {},
    });
  });

  it('reads a null id as no id, so the call is never answered', () => {
    const message = parseMessage('{"jsonrpc":"2.0","id":null,"method":"ping"}');

    assert.equal(message.kind, 'notification');
  });

  it('reports unparseable input as a parse error with no id', () => {
    const message = refusal('{"jsonrpc":"2.0",');

    assert.equal(message.error.code, PARSE_ERROR);
    assert.equal(message.id, null);
  });

  it('rejects a JSON value that is not an object', () => {
    for (const line of ['[]', '"hello"', '42', 'null']) {
      assert.equal(refusal(line).error.code, INVALID_REQUEST);
    }
  });

  it('rejects another JSON-RPC version, answering on the id it carried', () => {
    const message = refusal('{"jsonrpc":"1.0","id":"a","method":"ping"}');

    assert.equal(message.id, 'a');
    assert.equal(message.error.code, INVALID_REQUEST);
  });

  it('rejects a message carrying neither a method nor an id', () => {
    assert.equal(refusal('{"jsonrpc":"2.0","params":{}}').id, null);
  });

  it('rejects positional params, which no method here takes', () => {
    const message = refusal(
      '{"jsonrpc":"2.0","id":1,"method":"ping","params":[1,2]}'
    );

    assert.equal(message.id, 1);
    assert.equal(message.error.code, INVALID_PARAMS);
  });

  it('refuses a request addressed by an id no response can carry back', () => {
    // Read as a notification it would be dropped, leaving the peer waiting on
    // an answer that can never be routed.
    const message = refusal('{"jsonrpc":"2.0","id":true,"method":"ping"}');

    assert.equal(message.id, null);
    assert.equal(message.error.code, INVALID_REQUEST);
  });

  it('refuses a fractional id, which MCP does not allow', () => {
    assert.equal(
      refusal('{"jsonrpc":"2.0","id":1.5,"method":"ping"}').id,
      null
    );
  });

  it('drops a batch, since no revision this server speaks carries one', () => {
    assert.equal(
      refusal('[{"jsonrpc":"2.0","id":1,"method":"ping"}]').id,
      null
    );
  });
});

describe('parseMessage — a notification is never answerable', () => {
  // JSON-RPC forbids answering a notification at all, so every way one can be
  // wrong has to end in silence rather than an error response.
  const cases: Record<string, string> = {
    'bad params shape':
      '{"jsonrpc":"2.0","method":"notifications/cancelled","params":[1]}',
    'wrong protocol version':
      '{"jsonrpc":"1.0","method":"notifications/initialized"}',
    'null id, which names no call':
      '{"jsonrpc":"1.0","id":null,"method":"notifications/initialized"}',
  };

  for (const [name, line] of Object.entries(cases)) {
    it(`stays silent on a notification with a ${name}`, () => {
      assert.equal(parseMessage(line).kind, 'ignored', line);
    });
  }
});

describe('parseMessage — a response is never answered', () => {
  const cases: Record<string, string> = {
    result: '{"jsonrpc":"2.0","id":7,"result":{}}',
    error: '{"jsonrpc":"2.0","id":7,"error":{"code":-1,"message":"no"}}',
    // The id a peer uses when it could not read ours. Answering it would bounce
    // between two servers applying this same rule.
    'null id': '{"jsonrpc":"2.0","id":null,"error":{"code":-1,"message":"no"}}',
  };

  for (const [name, line] of Object.entries(cases)) {
    it(`drops a response carrying a ${name}`, () => {
      assert.equal(parseMessage(line).kind, 'ignored', line);
    });
  }
});

describe('responses', () => {
  it('carry the protocol version and the request id', () => {
    assert.deepEqual(successResponse(3, {ok: true}), {
      jsonrpc: '2.0',
      id: 3,
      result: {ok: true},
    });
    assert.deepEqual(errorResponse(null, PARSE_ERROR, 'bad json'), {
      jsonrpc: '2.0',
      id: null,
      error: {code: PARSE_ERROR, message: 'bad json'},
    });
  });
});
