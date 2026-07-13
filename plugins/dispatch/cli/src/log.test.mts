import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatLine, formatValue } from './log.mts';

describe('logfmt', () => {
  it('leaves a simple value bare', () => {
    assert.equal(formatValue('CLC-945'), 'CLC-945');
    assert.equal(formatValue(12), '12');
    assert.equal(formatValue(true), 'true');
  });

  it('quotes anything that would break key=value scanning', () => {
    assert.equal(formatValue('two words'), '"two words"');
    assert.equal(formatValue('a=b'), '"a=b"');
    assert.equal(formatValue(''), '""');
    assert.equal(formatValue('say "hi"'), '"say \\"hi\\""');
  });

  it('renders an absent value as an empty pair, not the string "null"', () => {
    assert.equal(formatLine('info', { cursor: null }), 'level=info cursor=');
  });

  it('omits an undefined field entirely', () => {
    assert.equal(
      formatLine('info', { cmd: 'graph.doc', kind: undefined }),
      'level=info cmd=graph.doc',
    );
  });

  it('leads with the level, then the fields in order', () => {
    assert.equal(
      formatLine('warn', { cmd: 'graph.doc', nodes: 3, detail: 'a cycle' }),
      'level=warn cmd=graph.doc nodes=3 detail="a cycle"',
    );
  });
});
