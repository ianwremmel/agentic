import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parseLogfmt} from '../../../test-harness.mts';
import {encodeLine, encodeValue} from './logfmt.mts';

describe('logfmt encoding', () => {
  it('leaves a bare value unquoted', () => {
    assert.equal(encodeValue('greet'), 'greet');
    assert.equal(encodeValue(42), '42');
    assert.equal(encodeValue(true), 'true');
  });

  it('quotes values a parser would otherwise mis-split', () => {
    assert.equal(encodeValue('Ada Lovelace'), '"Ada Lovelace"');
    assert.equal(encodeValue('a=b'), '"a=b"');
    assert.equal(encodeValue(''), '""');
  });

  it('escapes quotes, backslashes, and newlines inside a quoted value', () => {
    assert.equal(encodeValue('say "hi"'), '"say \\"hi\\""');
    assert.equal(encodeValue('C:\\tmp dir'), '"C:\\\\tmp dir"');
    assert.equal(encodeValue('one\ntwo'), '"one\\ntwo"');
  });

  it('round-trips a hostile value through encode and parse', () => {
    const hostile = 'name="Ada Lovelace"\nlevel=error \\ done';
    const parsed = parseLogfmt(encodeLine({msg: hostile, level: 'info'}));

    assert.deepEqual(parsed, {msg: hostile, level: 'info'});
  });

  it('drops undefined fields and keeps key order', () => {
    assert.equal(
      encodeLine({level: 'info', msg: 'greeted', name: undefined, count: 0}),
      'level=info msg=greeted count=0'
    );
  });
});
