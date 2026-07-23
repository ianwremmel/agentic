import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runDispatch, type DispatchResult} from '../../../test-harness.mts';

async function graphDb(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-fill-'));
  return path.join(dir, 'graph.db');
}

function run(db: string, args: string[]): Promise<DispatchResult> {
  return runDispatch(['graph', ...args, '--db', db]);
}

/** `count` available tasks T1..Tn in project P. */
async function seedTasks(db: string, count: number): Promise<void> {
  await run(db, ['project', 'set', '--id', 'P']);
  for (let n = 1; n <= count; n += 1) {
    const result = await run(db, [
      'task',
      'set',
      '--id',
      `T${String(n)}`,
      '--project',
      'P',
      '--role',
      'available',
    ]);
    assert.equal(result.code, 0, result.stderr);
  }
}

describe('fill', () => {
  it('claims up to the free-slot count under minted agent ids', async () => {
    const db = await graphDb();
    await seedTasks(db, 4); // default maxParallel is 3

    const {code, stdout} = await run(db, ['fill']);
    assert.equal(code, 0);
    assert.match(
      stdout,
      /<dispatches slots-free="3" tickets="3" reviews="0">/u
    );
    assert.match(stdout, /<ticket id="T1" agent="wt-\d+-[0-9a-f]{8}"/u);
    assert.match(stdout, /<ticket id="T3"/u);
    assert.doesNotMatch(stdout, /<ticket id="T4"/u);

    // The claims were really taken: every printed ticket is now in-flight.
    const doc = await run(db, ['doc']);
    assert.match(doc.stdout, /id="T1"[^>]*claimed-by="wt-/u);
  });

  it('a live held slot shrinks admission; --limit overrides it', async () => {
    const db = await graphDb();
    await seedTasks(db, 4);
    await run(db, ['slot', 'acquire', '--agent', 'builder-a']);

    const bounded = await run(db, ['fill']);
    assert.match(bounded.stdout, /<dispatches slots-free="2" tickets="2"/u);

    const overridden = await run(db, ['fill', '--limit', '2']);
    assert.match(overridden.stdout, /tickets="2"/u);
    assert.match(overridden.stdout, /<ticket id="T3"/u);
    assert.match(overridden.stdout, /<ticket id="T4"/u);
  });

  it('takes the review lock on a ready-unreviewed milestone exactly once', async () => {
    const db = await graphDb();
    await run(db, ['project', 'set', '--id', 'P']);
    await run(db, ['milestone', 'set', '--id', 'M1', '--project', 'P']);
    await run(db, [
      'task',
      'set',
      '--id',
      'T1',
      '--project',
      'P',
      '--role',
      'verified',
      '--milestone',
      'M1',
    ]);

    const first = await run(db, ['fill']);
    assert.match(
      first.stdout,
      /<review milestone="M1" project="P" name="M1" agent="review-M1-\d+-[0-9a-f]{8}"\/>/u
    );

    // The lock is held live now, so the next tick must not re-dispatch it.
    const second = await run(db, ['fill']);
    assert.match(
      second.stdout,
      /<dispatches slots-free="3" tickets="0" reviews="0"\/>/u
    );
  });

  it('prints an empty element when nothing is dispatchable', async () => {
    const db = await graphDb();
    await run(db, ['project', 'set', '--id', 'P']);

    const {code, stdout} = await run(db, ['fill']);
    assert.equal(code, 0);
    assert.match(
      stdout,
      /^<dispatches slots-free="3" tickets="0" reviews="0"\/>/u
    );
  });
});
