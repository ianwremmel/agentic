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
      '--role',
      'verified',
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
      '--role',
      'available',
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

  it('milestone show prints one milestone and only its members', async () => {
    const db = await graphDb();
    await seed(db);

    const {code, stdout} = await run(db, ['milestone', 'show', '--id', 'M1']);
    assert.equal(code, 0);
    assert.match(
      stdout,
      /<milestone id="M1"[^>]*ready-for-review="true" review-recorded="false"/u
    );
    assert.match(stdout, /<node id="T1"/u);
    assert.doesNotMatch(stdout, /<node id="T2"/u);
  });

  it('milestone show exits 4 on a milestone the graph does not hold', async () => {
    const db = await graphDb();
    await seed(db);

    const {code, stderr} = await run(db, ['milestone', 'show', '--id', 'M9']);
    assert.equal(code, 4);
    assert.match(stderr, /no milestone "M9"/u);
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
    assert.match(peek.stdout, /<ticket id="T2" target-kind="pr"/u);

    const claimed = await run(db, ['next', '--claim', '--agent', 'agent-a']);
    assert.match(claimed.stdout, /<ticket id="T2"/u);

    // Now claimed, T2 is in-flight and off the frontier.
    const doc = await run(db, ['doc']);
    assert.match(
      doc.stdout,
      /id="T2"[^>]*state="in-flight"[^>]*claimed-by="agent-a"/u
    );
    const again = await run(db, ['next']);
    assert.equal(again.stdout.trim(), '');
  });

  it('prints the next task as a <ticket> XML element', async () => {
    const db = await graphDb();
    await run(db, ['project', 'set', '--id', 'P']);
    await run(db, [
      'task',
      'set',
      '--id',
      'T',
      '--project',
      'P',
      '--role',
      'available',
      '--url',
      'https://x/a b',
    ]);

    const {stdout} = await run(db, ['next']);
    // XML, not logfmt — a space in the url sits safely inside the attribute.
    assert.match(
      stdout,
      /^<ticket id="T" target-kind="pr" url="https:\/\/x\/a b"\/>/u
    );
  });

  it('refuses an edge that would close a dependency cycle', async () => {
    const db = await graphDb();
    await run(db, ['project', 'set', '--id', 'P']);
    for (const id of ['A', 'B']) {
      await run(db, [
        'task',
        'set',
        '--id',
        id,
        '--project',
        'P',
        '--role',
        'available',
      ]);
    }
    await run(db, ['edge', 'add', '--blocker', 'A', '--blocked', 'B']);

    const {code, stderr} = await run(db, [
      'edge',
      'add',
      '--blocker',
      'B',
      '--blocked',
      'A',
    ]);
    assert.equal(code, 4);
    assert.match(stderr, /would create a dependency cycle/u);
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
  it('exits 4 on a value outside the protocol role vocabulary', async () => {
    const db = await graphDb();
    const {code, stderr} = await run(db, [
      'task',
      'set',
      '--id',
      'A',
      '--project',
      'P',
      '--role',
      'Ready for QA',
    ]);
    assert.equal(code, 4);
    assert.match(stderr, /"Ready for QA" is not a protocol role/u);
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
    assert.match(stdout, /--role/u);
  });
});

describe('agent lifecycle bookkeeping', () => {
  it('claim without --agent mints and prints the agent id', async () => {
    const db = await graphDb();
    await seed(db);
    await run(db, ['record-review', '--id', 'M1']);

    const {code, stdout} = await run(db, ['claim', '--id', 'T2']);
    assert.equal(code, 0);
    const match =
      /<claim id="T2" agent="(wt-\d+-[0-9a-f]{4})" outcome="claimed"\/>/u.exec(
        stdout
      );
    assert.ok(match, stdout);

    // The minted id is the claim's real holder: it can heartbeat.
    const beat = await run(db, [
      'heartbeat',
      '--id',
      'T2',
      '--agent',
      match[1] ?? '',
    ]);
    assert.equal(beat.code, 0, beat.stderr);
  });

  it('an agent-wide heartbeat refreshes every claim and the slot in one call', async () => {
    const db = await graphDb();
    await seed(db);
    await run(db, ['record-review', '--id', 'M1']);
    await run(db, ['claim', '--id', 'T2', '--agent', 'agent-a']);
    await run(db, ['slot', 'acquire', '--agent', 'agent-a']);

    const {code, stdout} = await run(db, ['heartbeat', '--agent', 'agent-a']);
    assert.equal(code, 0);
    assert.match(
      stdout,
      /<heartbeat agent="agent-a" claims="1" slot="true"\/>/u
    );
  });

  it('an agent-wide heartbeat fails when the agent holds nothing', async () => {
    const db = await graphDb();
    await seed(db);

    const {code, stderr} = await run(db, ['heartbeat', '--agent', 'ghost']);
    assert.equal(code, 4);
    assert.match(stderr, /holds no claim and no slot/u);
  });

  it('outcome set releases the reporting agent compute slot with its claim', async () => {
    const db = await graphDb();
    await seed(db);
    await run(db, ['record-review', '--id', 'M1']);
    await run(db, ['claim', '--id', 'T2', '--agent', 'agent-a']);
    await run(db, ['slot', 'acquire', '--agent', 'agent-a']);

    const outcome = await run(db, [
      'outcome',
      'set',
      '--id',
      'T2',
      '--agent',
      'agent-a',
      '--outcome',
      'delivered',
    ]);
    assert.equal(outcome.code, 0, outcome.stderr);

    const status = await run(db, ['slot', 'status']);
    assert.match(status.stdout, /<slots max="3" held="0" free="3">/u);
  });

  it('claim and heartbeat record where the work is checked out', async () => {
    const db = await graphDb();
    await seed(db);
    await run(db, ['record-review', '--id', 'M1']);
    await run(db, [
      'claim',
      '--id',
      'T2',
      '--agent',
      'agent-a',
      '--branch',
      'feat/t2',
    ]);
    const beat = await run(db, [
      'heartbeat',
      '--agent',
      'agent-a',
      '--worktree',
      '/tmp/wt/t2',
    ]);
    assert.equal(beat.code, 0, beat.stderr);

    // The recorded facts surface in the document, so any agent can locate
    // in-flight work through the store.
    const doc = await run(db, ['doc']);
    assert.match(
      doc.stdout,
      /id="T2"[^>]*claim-worktree="\/tmp\/wt\/t2" claim-branch="feat\/t2"/u
    );
  });
});

describe('summary terminal attribute', () => {
  it('is false while work remains and true once everything is resolved', async () => {
    const db = await graphDb();
    await seed(db);

    const open = await run(db, ['summary']);
    assert.match(open.stdout, /^<summary terminal="false">/u);

    // Resolve everything: T2 verified closes the queue; no claims are held.
    await run(db, [
      'task',
      'set',
      '--id',
      'T2',
      '--project',
      'P',
      '--role',
      'verified',
      '--milestone',
      'M2',
    ]);

    // Both gates are now ready but unreviewed — still not terminal.
    await run(db, ['record-review', '--id', 'M1']);
    const gated = await run(db, ['summary']);
    assert.match(gated.stdout, /^<summary terminal="false">/u);

    await run(db, ['record-review', '--id', 'M2']);
    const done = await run(db, ['summary']);
    assert.match(done.stdout, /^<summary terminal="true">/u);
  });

  it('a live claim alone holds the loop open', async () => {
    const db = await graphDb();
    await seed(db);
    await run(db, ['record-review', '--id', 'M1']);
    await run(db, ['claim', '--id', 'T2', '--agent', 'agent-a']);
    await run(db, [
      'task',
      'set',
      '--id',
      'T2',
      '--project',
      'P',
      '--role',
      'verified',
      '--milestone',
      'M2',
    ]);
    await run(db, ['record-review', '--id', 'M2']);

    const held = await run(db, ['summary']);
    assert.match(held.stdout, /^<summary terminal="false">/u);
  });
});
