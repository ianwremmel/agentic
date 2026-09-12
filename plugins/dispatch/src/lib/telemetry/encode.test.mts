import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {encode} from './encode.mts';

describe('encode', () => {
  it('omits a field with nothing in it', () => {
    // This is what keeps a line short: every exporter sets the fields a record
    // has nothing to say about to `undefined`.
    assert.equal(encode({a: 1, b: undefined}), '{"a":1}');
  });

  it('keeps the message and stack of an Error', () => {
    // `JSON.stringify` renders an Error as `{}`. The SDK hands `diag` real
    // Errors, and losing them leaves a diagnostic line saying nothing.
    const parsed = JSON.parse(encode({error: new TypeError('bad input')})) as {
      error: {message: string; name: string; stack: string};
    };

    assert.equal(parsed.error.name, 'TypeError');
    assert.equal(parsed.error.message, 'bad input');
    assert.match(parsed.error.stack, /TypeError: bad input/u);
  });

  it('writes a BigInt rather than throwing on it', () => {
    assert.equal(
      encode({count: 9_007_199_254_740_993n}),
      '{"count":"9007199254740993"}'
    );
  });

  it('writes a Symbol rather than dropping it', () => {
    assert.equal(encode({tag: Symbol('probe')}), '{"tag":"Symbol(probe)"}');
  });

  it('survives a value that references itself', () => {
    // Exporting runs inside the caller's own `emit()`, so a throw takes down
    // the code being observed.
    const loop: Record<string, unknown> = {name: 'tick'};
    loop.self = loop;

    assert.equal(
      encode({loop}),
      '{"loop":{"name":"tick","self":"[circular]"}}'
    );
  });
});
