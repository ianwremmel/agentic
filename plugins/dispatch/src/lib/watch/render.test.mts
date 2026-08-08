import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {renderSnapshot} from './render.mts';
import type {PrSnapshot} from './snapshot.mts';

const SNAP: PrSnapshot = {
  head: 'abc123',
  state: 'OPEN',
  draft: false,
  merged: false,
  mergeable: 'MERGEABLE',
  mergeState: 'DIRTY',
  reviewDecision: 'CHANGES_REQUESTED',
  rollup: 'FAILURE',
  checks: [{name: 'test <&>', conclusion: 'FAILURE', url: 'https://ci/1'}],
  reviews: [
    {
      author: 'human',
      state: 'CHANGES_REQUESTED',
      submittedAt: 'x',
      mine: false,
    },
  ],
  threads: [
    {
      id: 't"1',
      resolved: false,
      outdated: false,
      lastAuthor: 'human',
      lastAt: 'x',
      mine: false,
    },
  ],
  comments: [],
  totals: {reviews: 1, threads: 1, comments: 0},
};

describe('renderSnapshot', () => {
  it('carries the gate signals in the vocabulary workers already read', () => {
    const xml = renderSnapshot('o/r', 7, SNAP);
    assert.match(xml, /<checks state="FAILURE">/u);
    assert.match(xml, /<merge-conflicts present="true"\/>/u);
    assert.match(xml, /<review author="human" state="CHANGES_REQUESTED"/u);
    // A running check reads PENDING, not a silent gap.
    assert.match(
      renderSnapshot('o/r', 7, {
        ...SNAP,
        checks: [{name: 'x', conclusion: null, url: null}],
      }),
      /conclusion="PENDING"/u
    );
  });

  it('escapes markup so a hostile check name cannot forge structure', () => {
    const xml = renderSnapshot('o/r', 7, SNAP);
    assert.match(xml, /name="test &lt;&amp;>"/u);
    assert.match(xml, /id="t&quot;1"/u);
    assert.doesNotMatch(xml, /<test /u);
  });
});
