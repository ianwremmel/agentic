import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runDispatch} from '../../test-harness.mts';

async function db(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-wait-'));
  return path.join(dir, 'graph.db');
}

describe('wait record and stats', () => {
  it('record prints the updated stats; stats prints one line per kind', async () => {
    const file = await db();
    const first = await runDispatch([
      'wait',
      'record',
      '--repo',
      'o/r',
      '--kind',
      'ci',
      '--elapsed',
      '120',
      '--db',
      file,
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(
      first.stdout,
      /^<wait repo="o\/r" kind="ci" count="1" median-s="120"\/>/u
    );

    await runDispatch([
      'wait',
      'record',
      '--repo',
      'o/r',
      '--kind',
      'reviewer',
      '--elapsed',
      '600',
      '--outcome',
      'approved',
      '--db',
      file,
    ]);

    const stats = await runDispatch([
      'wait',
      'stats',
      '--repo',
      'o/r',
      '--db',
      file,
    ]);
    assert.equal(stats.code, 0);
    assert.match(stats.stdout, /kind="ci" count="1" median-s="120"/u);
    assert.match(stats.stdout, /kind="reviewer" count="1" median-s="600"/u);
  });

  it('rejects an unknown kind and a malformed elapsed as usage errors', async () => {
    const file = await db();
    const kind = await runDispatch([
      'wait',
      'record',
      '--repo',
      'o/r',
      '--kind',
      'lunch',
      '--elapsed',
      '60',
      '--db',
      file,
    ]);
    assert.equal(kind.code, 2);
    assert.match(kind.stderr, /"lunch" is not a wait kind/u);

    const elapsed = await runDispatch([
      'wait',
      'record',
      '--repo',
      'o/r',
      '--kind',
      'ci',
      '--elapsed',
      'fast',
      '--db',
      file,
    ]);
    assert.equal(elapsed.code, 2);
    assert.match(
      elapsed.stderr,
      /--elapsed must be a non-negative whole number/u
    );
  });
});
