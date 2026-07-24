import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  errorResponse,
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

  it('drops a response rather than answering it', () => {
    // Answering would bounce off a peer applying the same rule, forever.
    const message = parseMessage('{"jsonrpc":"2.0","id":7,"result":{}}');

    assert.equal(message.kind, 'ignored');
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
  });
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
