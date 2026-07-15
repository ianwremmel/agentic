import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runDispatch, type DispatchResult} from '../../../test-harness.mts';

async function graphDb(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-graph-'));
  return path.join(dir, 'graph.db');
}

/** Run one `dispatch graph …` command against a specific database. */
function run(db: string, args: string[]): Promise<DispatchResult> {
  return runDispatch(['graph', ...args, '--db', db]);
}

/** A two-milestone graph: T1 done in M1, T2 available in M2, M1 blocks M2. */
async function seed(db: string): Promise<void> {
  const steps = [
    ['project', 'set', '--id', 'P'],
    ['milestone', 'set', '--id', 'M1', '--project', 'P'],
    ['milestone', 'set', '--id', 'M2', '--project', 'P'],
    ['edge', 'add', '--blocker', 'M1', '--blocked', 'M2'],
    [
      'task',
      'set',
      '--id',
      'T1',
      '--project',
      'P',
      '--state',
      'Done',
      '--milestone',
      'M1',
    ],
    [
      'task',
      'set',
      '--id',
      'T2',
      '--project',
      'P',
      '--state',
      'Todo',
      '--milestone',
      'M2',
    ],
  ];
  for (const step of steps) {
    const result = await run(db, step);
    assert.equal(result.code, 0, `${step.join(' ')}: ${result.stderr}`);
  }
}

describe('building and reading the graph', () => {
  it('derives the frontier from typed writes', async () => {
    const db = await graphDb();
    await seed(db);

    const {code, stdout} = await run(db, ['doc']);
    assert.equal(code, 0);
    // T2 is gated behind M1, which is ready but unreviewed.
    assert.match(stdout, /<ticket id="T2" blocked-by="" gated-by="M1"/u);
    assert.doesNotMatch(stdout, /<ticket id="T2" rank=/u);
  });

  it('opens the milestone gate once the review is recorded', async () => {
    const db = await graphDb();
    await seed(db);

    const recorded = await run(db, ['record-review', '--id', 'M1']);
    assert.equal(recorded.code, 0, recorded.stderr);

    const {stdout} = await run(db, ['doc']);
    assert.match(stdout, /<ticket id="T2" rank="1"/u);
  });

  it('refuses to record a review of a milestone with open work', async () => {
    const db = await graphDb();
    await seed(db);

    const {code, stderr} = await run(db, ['record-review', '--id', 'M2']);
    assert.equal(code, 4);
    assert.match(stderr, /not ready for review/u);
  });

  it('reset clears the graph', async () => {
    const db = await graphDb();
    await seed(db);
    assert.equal((await run(db, ['reset'])).code, 0);

    const {stdout} = await run(db, ['doc']);
    assert.doesNotMatch(stdout, /<node /u);
  });
});

describe('next and claim', () => {
  it('next prints the top available task; --claim grabs it atomically', async () => {
    const db = await graphDb();
    await seed(db);
    await run(db, ['record-review', '--id', 'M1']); // unblock T2

    const peek = await run(db, ['next']);
    assert.match(peek.stdout, /id=T2 target-kind=pr/u);

    const claimed = await run(db, ['next', '--claim', '--agent', 'agent-a']);
    assert.match(claimed.stdout, /id=T2/u);

    // Now claimed, T2 is in-flight and off the frontier.
    const doc = await run(db, ['doc']);
    assert.match(
      doc.stdout,
      /id="T2"[^>]*state="in-flight"[^>]*claimed-by="agent-a"/u
    );
    const again = await run(db, ['next']);
    assert.equal(again.stdout.trim(), '');
  });

  it('quotes a next line value that contains a space, so it stays one field', async () => {
    const db = await graphDb();
    await run(db, ['project', 'set', '--id', 'P']);
    await run(db, [
      'task',
      'set',
      '--id',
      'T',
      '--project',
      'P',
      '--state',
      'Todo',
      '--url',
      'https://x/a b',
    ]);

    const {stdout} = await run(db, ['next']);
    assert.match(stdout, /url="https:\/\/x\/a b"/u);
  });

  it('a second agent cannot claim a live-held task', async () => {
    const db = await graphDb();
    await seed(db);
    await run(db, ['record-review', '--id', 'M1']);
    await run(db, ['claim', '--id', 'T2', '--agent', 'agent-a']);

    const {code, stderr} = await run(db, [
      'claim',
      '--id',
      'T2',
      '--agent',
      'agent-b',
    ]);
    assert.equal(code, 3);
    assert.match(stderr, /held by a live claim from agent agent-a/u);
  });

  it('reclaims a stale claim with --stale-after 0', async () => {
    const db = await graphDb();
    await seed(db);
    await run(db, ['record-review', '--id', 'M1']);
    await run(db, ['claim', '--id', 'T2', '--agent', 'agent-a']);

    const reclaim = await run(db, [
      'claim',
      '--id',
      'T2',
      '--agent',
      'agent-b',
      '--stale-after',
      '0',
    ]);
    assert.equal(reclaim.code, 0, reclaim.stderr);

    const doc = await run(db, ['doc']);
    assert.match(doc.stdout, /id="T2"[^>]*claimed-by="agent-b"/u);
  });

  it('heartbeat fails once a claim has been reclaimed', async () => {
    const db = await graphDb();
    await seed(db);
    await run(db, ['record-review', '--id', 'M1']);
    await run(db, ['claim', '--id', 'T2', '--agent', 'agent-a']);
    await run(db, [
      'claim',
      '--id',
      'T2',
      '--agent',
      'agent-b',
      '--stale-after',
      '0',
    ]);

    const {code, stderr} = await run(db, [
      'heartbeat',
      '--id',
      'T2',
      '--agent',
      'agent-a',
    ]);
    assert.equal(code, 4);
    assert.match(stderr, /holds no claim/u);
  });
});

describe('what a caller sees when it gets the call wrong', () => {
  it('exits 4 on a native state no mapping covers', async () => {
    const db = await graphDb();
    const {code, stderr} = await run(db, [
      'task',
      'set',
      '--id',
      'A',
      '--project',
      'P',
      '--state',
      'Ready for QA',
    ]);
    assert.equal(code, 4);
    assert.match(stderr, /no mapping for the native state "Ready for QA"/u);
  });

  it('exits 2 on an unknown flag, and answers with the subcommand usage', async () => {
    const db = await graphDb();
    const {code, stderr} = await run(db, ['task', 'set', '--bogus']);
    assert.equal(code, 2);
    assert.match(stderr, /usage: dispatch graph task set/u);
  });

  it('exits 2 and lists the subcommands when the group is named alone', async () => {
    const {code, stderr} = await runDispatch(['graph']);
    assert.equal(code, 2);
    assert.match(stderr, /graph needs a subcommand/u);
    assert.match(stderr, /record-review/u);
  });

  it('answers --help for a nested subcommand with that subcommand usage', async () => {
    const {code, stdout} = await runDispatch([
      'graph',
      'task',
      'set',
      '--help',
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /usage: dispatch graph task set/u);
    assert.match(stdout, /--state/u);
  });
});
