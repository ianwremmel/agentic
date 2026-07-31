import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {attr, element, text} from './xml.mts';

describe('xml escaping', () => {
  it('escapes the three markup characters in text', () => {
    assert.equal(text('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  });

  it('does not escape quotes in text', () => {
    assert.equal(text('say "hi"'), 'say "hi"');
  });

  it('additionally escapes the double quote in an attribute', () => {
    assert.equal(attr('a "b" & c'), 'a &quot;b&quot; &amp; c');
  });
});

describe('element', () => {
  it('self-closes with no children', () => {
    assert.equal(element('  ', 'x', 'id="1"'), '  <x id="1"/>');
  });

  it('wraps children between an open and close tag', () => {
    assert.equal(
      element('  ', 'x', 'id="1"', ['    <y/>']),
      '  <x id="1">\n    <y/>\n  </x>'
    );
  });
});
