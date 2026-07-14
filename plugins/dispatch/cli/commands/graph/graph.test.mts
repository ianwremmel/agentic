import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runDispatch, type DispatchResult} from '../../../test-harness.mts';

/** A graph database of its own per test, so nothing leaks between them. */
async function graphDb(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-graph-'));
  return path.join(dir, 'graph.db');
}

function run(
  db: string,
  args: string[],
  input?: string
): Promise<DispatchResult> {
  return runDispatch(
    ['graph', ...args, '--db', db],
    input === undefined ? {} : {input}
  );
}

/** Two tickets in one milestone, the first blocking the second. */
const PAYLOAD = JSON.stringify({
  cursor: '2026-07-11T00:00:00.000Z',
  projects: [{id: 'P', name: 'Project'}],
  milestones: [{id: 'm1', project: 'P', name: 'One', sortOrder: 1}],
  nodes: [
    {id: 'CLC-1', project: 'P', state: 'Todo', milestone: 'm1'},
    {
      id: 'CLC-2',
      project: 'P',
      state: 'Todo',
      milestone: 'm1',
      blockedBy: ['CLC-1'],
    },
  ],
});

describe('the producer loop, end to end', () => {
  it('ingests a payload on stdin and derives the frontier from it', async () => {
    const db = await graphDb();

    const ingest = await run(db, ['ingest', '--full'], PAYLOAD);
    assert.equal(ingest.code, 0, ingest.stderr);

    const {code, stdout} = await run(db, ['doc']);

    assert.equal(code, 0);
    // CLC-1 is unblocked and rank 1; CLC-2 waits behind it.
    assert.match(stdout, /<ticket id="CLC-1" rank="1"/u);
    assert.doesNotMatch(stdout, /<ticket id="CLC-2" rank=/u);
    assert.match(stdout, /<ticket id="CLC-2" blocked-by="CLC-1"/u);
  });

  it('carries the cursor back, so the next fetch can be a delta', async () => {
    const db = await graphDb();
    await run(db, ['ingest', '--full'], PAYLOAD);

    const {stdout} = await run(db, ['cursor', '--source', 'linear']);

    assert.equal(stdout.trim(), '2026-07-11T00:00:00.000Z');
  });

  it('prints nothing for an unknown cursor, which is the first-run signal to sync fully', async () => {
    const db = await graphDb();

    const {code, stdout} = await run(db, ['cursor', '--source', 'linear']);

    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  it('moves the frontier on when a delta resolves the blocker', async () => {
    const db = await graphDb();
    await run(db, ['ingest', '--full'], PAYLOAD);

    const delta = JSON.stringify({
      cursor: '2026-07-12T00:00:00.000Z',
      nodes: [{id: 'CLC-1', project: 'P', state: 'Done', milestone: 'm1'}],
    });
    const ingest = await run(db, ['ingest'], delta);
    assert.equal(ingest.code, 0, ingest.stderr);

    const {stdout} = await run(db, ['doc']);

    assert.match(stdout, /<ticket id="CLC-2" rank="1"/u);
    assert.doesNotMatch(stdout, /<ticket id="CLC-1" rank=/u);
  });

  it('withholds an excluded ticket from the frontier while still tracking it', async () => {
    const db = await graphDb();
    await run(db, ['ingest', '--full'], PAYLOAD);

    await run(db, ['exclude', 'add', 'CLC-1', '--kind', 'in-flight']);
    const excluded = await run(db, ['doc']);
    assert.doesNotMatch(excluded.stdout, /<ticket id="CLC-1" rank=/u);
    assert.match(excluded.stdout, /id="CLC-1"[^>]*excluded="in-flight"/u);

    await run(db, ['exclude', 'remove', 'CLC-1']);
    const restored = await run(db, ['doc']);
    assert.match(restored.stdout, /<ticket id="CLC-1" rank="1"/u);
  });
});

describe('the milestone gate', () => {
  const GATED = JSON.stringify({
    projects: [{id: 'P', name: 'Project'}],
    milestones: [
      {id: 'm1', project: 'P', name: 'One', sortOrder: 1},
      {id: 'm2', project: 'P', name: 'Two', sortOrder: 2},
    ],
    nodes: [
      {id: 'CLC-1', project: 'P', state: 'Done', milestone: 'm1'},
      {id: 'CLC-2', project: 'P', state: 'Todo', milestone: 'm2'},
    ],
  });

  it('holds the next milestone shut until the review is recorded, then opens it', async () => {
    const db = await graphDb();
    await run(db, ['ingest', '--full'], GATED);

    const gated = await run(db, ['doc']);
    assert.match(
      gated.stdout,
      /<ticket id="CLC-2" blocked-by="" gated-by="m1"/u
    );
    assert.match(
      gated.stdout,
      /<milestone id="m1"[^>]*ready-for-review="true" review-recorded="false"/u
    );

    const recorded = await run(db, ['record-review', 'm1']);
    assert.equal(recorded.code, 0, recorded.stderr);

    const opened = await run(db, ['doc']);
    assert.match(opened.stdout, /<ticket id="CLC-2" rank="1"/u);
  });

  it('re-closes the gate when the review files a follow-up ticket into the milestone', async () => {
    const db = await graphDb();
    await run(db, ['ingest', '--full'], GATED);
    await run(db, ['record-review', 'm1']);

    const followUp = JSON.stringify({
      nodes: [{id: 'CLC-3', project: 'P', state: 'Todo', milestone: 'm1'}],
    });
    await run(db, ['ingest'], followUp);

    const {stdout} = await run(db, ['doc']);

    // The milestone has open work again, so the recorded review no longer counts
    // and CLC-2 is gated once more.
    assert.match(
      stdout,
      /<milestone id="m1"[^>]*ready-for-review="false" review-recorded="false"/u
    );
    assert.match(stdout, /<ticket id="CLC-2" blocked-by="" gated-by="m1"/u);
    assert.match(stdout, /<ticket id="CLC-3" rank="1"/u);
  });

  it('refuses to record a review of a milestone that still has open work', async () => {
    const db = await graphDb();
    await run(db, ['ingest', '--full'], PAYLOAD);

    const {code, stderr} = await run(db, ['record-review', 'm1']);

    assert.equal(code, 4);
    assert.match(
      stderr,
      /not ready for review: 2 of 2 tickets are still open/u
    );
    assert.match(stderr, /hint: .*verified or canceled/u);
  });
});

describe('what a caller sees when it gets the call wrong', () => {
  it('exits 4 on a payload that is not JSON, and says how to fix it', async () => {
    const db = await graphDb();

    const {code, stderr} = await run(db, ['ingest'], 'not json');

    assert.equal(code, 4);
    assert.match(stderr, /error: the ingest payload is not valid JSON/u);
    assert.match(stderr, /hint: emit a single JSON object/u);
  });

  it('exits 4 on a native state no mapping covers, rather than guessing', async () => {
    const db = await graphDb();
    const payload = JSON.stringify({
      nodes: [{id: 'A', project: 'P', state: 'Ready for QA'}],
    });

    const {code, stderr} = await run(db, ['ingest'], payload);

    assert.equal(code, 4);
    assert.match(stderr, /no mapping for the native state "Ready for QA"/u);
  });

  it('exits 2 on an unknown flag, and answers with the subcommand usage, not the group listing', async () => {
    const db = await graphDb();

    const {code, stderr} = await run(db, ['ingest', '--bogus']);

    assert.equal(code, 2);
    assert.match(stderr, /usage: dispatch graph ingest/u);
    assert.match(stderr, /--full/u);
    // The list of graph subcommands says nothing about the flag that was wrong.
    assert.doesNotMatch(stderr, /record-review {2,}Record/u);
  });

  it('exits 2 and lists the subcommands when the group is named alone', async () => {
    const {code, stderr} = await runDispatch(['graph']);

    assert.equal(code, 2);
    assert.match(stderr, /graph needs a subcommand/u);
    assert.match(stderr, /ingest/u);
    assert.match(stderr, /record-review/u);
  });

  it('answers --help for a subcommand with that subcommand usage', async () => {
    const {code, stdout} = await runDispatch(['graph', 'ingest', '--help']);

    assert.equal(code, 0);
    assert.match(stdout, /usage: dispatch graph ingest/u);
    assert.match(stdout, /--full/u);
  });
});
