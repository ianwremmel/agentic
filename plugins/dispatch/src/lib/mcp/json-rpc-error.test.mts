import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DispatchError} from '../errors/index.mts';
import {JsonRpcError} from './json-rpc-error.mts';

describe('JsonRpcError', () => {
  it('is a DispatchError carrying a protocol code', () => {
    const error = new JsonRpcError(-32601, 'method not found');
    assert.ok(error instanceof DispatchError);
    assert.equal(error.code, -32601);
    assert.match(error.toString(), /method not found/);
  });
});
