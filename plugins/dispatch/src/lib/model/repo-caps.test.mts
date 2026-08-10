import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {UsageError} from '../errors/index.mts';
import {DEFAULT_REPO_CAPS, limitFor, parseRepoLimits} from './repo-caps.mts';

describe('parseRepoLimits', () => {
  it('reads one limit per repo, ignoring surrounding whitespace', () => {
    assert.deepEqual(parseRepoLimits(' o/a = 2 , o/b=0 ', 'flag'), {
      'o/a': 2,
      'o/b': 0,
    });
  });

  it('reads an empty list as no overrides', () => {
    assert.deepEqual(parseRepoLimits('', 'flag'), {});
  });

  it('refuses an entry that is not owner/repo=<whole number>', () => {
    for (const spec of ['o/a', 'a=1', 'o/a=', 'o/a=-1', 'o/a=1.5', 'o/a=two']) {
      assert.throws(
        () => parseRepoLimits(spec, 'flag'),
        UsageError,
        `expected "${spec}" to be refused`
      );
    }
  });
});

describe('limitFor', () => {
  it('prefers a repo override over the global default', () => {
    const policy = {
      ...DEFAULT_REPO_CAPS,
      openPrs: 5,
      openPrsByRepo: {'o/a': 1},
    };
    assert.equal(limitFor(policy, 'o/a', 'open-prs'), 1);
    assert.equal(limitFor(policy, 'o/b', 'open-prs'), 5);
  });

  it('reads each cap from its own overrides', () => {
    const policy = {
      openPrs: 5,
      inFlightBuilds: 2,
      openPrsByRepo: {'o/a': 1},
      inFlightBuildsByRepo: {},
    };
    assert.equal(limitFor(policy, 'o/a', 'in-flight-builds'), 2);
  });
});
