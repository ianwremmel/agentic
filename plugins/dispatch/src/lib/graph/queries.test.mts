import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ticket as baseTicket} from '../command/test-support.mts';
import {Database} from '../db/database.mts';
import type {Status, Ticket} from '../model/index.mts';
import {
  CoordinationStore,
  EdgeStore,
  MilestoneStore,
  PrStore,
  ProjectStore,
  SessionStore,
  TicketStore,
} from '../stores/index.mts';
import {
  classifiedItems,
  dispatchQueue,
  frontier,
  milestoneStates,
} from './queries.mts';

const NOW = '2026-08-03T12:00:00.000Z';
/** One hour before NOW — stale under the 300 s default window. */
const STALE = '2026-08-03T11:00:00.000Z';

async function fresh(): Promise<Database> {
  const db = await Database.open(':memory:');
  await new ProjectStore(db).upsertProject({
    id: 'P',
    name: 'P',
    source: 'linear',
  });
  return db;
}

async function addTicket(
  db: Database,
  id: string,
  status: Status = 'available',
  extra: Partial<Ticket> = {}
): Promise<void> {
  await new TicketStore(db).upsertTicket({
    ...baseTicket(id, 'P'),
    status,
    ...extra,
  });
}

async function block(
  db: Database,
  blocker: string,
  blocked: string
): Promise<void> {
  await new EdgeStore(db).addEdge(blocker, blocked);
}

async function session(
  db: Database,
  id: string,
  heartbeatAt: string
): Promise<void> {
  await new SessionStore(db).register({
    id,
    startedAt: STALE,
    heartbeatAt,
  });
}

async function claim(db: Database, node: string, s: string): Promise<void> {
  await new CoordinationStore(db).claim({
    node,
    session: s,
    claimedAt: NOW,
  });
}

async function frontierIds(db: Database): Promise<string[]> {
  return (await frontier(db, {now: NOW})).map((entry) => entry.item.id);
}

async function queueOf(
  db: Database
): Promise<{id: string; pass: string | null}[]> {
  return (await dispatchQueue(db, {now: NOW})).map(({entry, pass}) => ({
    id: entry.item.id,
    pass,
  }));
}

async function classificationOf(db: Database, id: string): Promise<string> {
  const entry = (await classifiedItems(db, {now: NOW})).find(
    (item) => item.item.id === id
  );
  assert.ok(entry, `expected ${id} in the classified items`);
  return entry.classification;
}

describe('blocking', () => {
  it('keeps a ticket blocked by an unresolved ancestor out of the frontier', async () => {
    const db = await fresh();
    await addTicket(db, 'A', 'in-progress');
    await addTicket(db, 'B');
    await block(db, 'A', 'B');

    assert.equal(await classificationOf(db, 'B'), 'blocked');
    assert.deepEqual(await frontierIds(db), []);
    await db.close();
  });

  it('unblocks dependents when the ancestor is canceled', async () => {
    const db = await fresh();
    await addTicket(db, 'A', 'canceled');
    await addTicket(db, 'B');
    await block(db, 'A', 'B');

    assert.deepEqual(await frontierIds(db), ['B']);
    await db.close();
  });

  it('holds dependents blocked behind a placeholder ancestor', async () => {
    const db = await fresh();
    await addTicket(db, 'B');
    await block(db, 'GHOST', 'B');

    assert.equal(await classificationOf(db, 'B'), 'blocked');
    const entry = (await classifiedItems(db, {now: NOW})).find(
      (item) => item.item.id === 'B'
    );
    assert.deepEqual(entry?.blockedBy, ['GHOST']);
    await db.close();
  });

  it('blocks transitively through unresolved intermediates only', async () => {
    const db = await fresh();
    await addTicket(db, 'A', 'in-progress');
    await addTicket(db, 'B', 'verified');
    await addTicket(db, 'C');
    await block(db, 'A', 'B');
    await block(db, 'B', 'C');

    // B is resolved, so A's unresolved state no longer reaches C.
    assert.deepEqual(await frontierIds(db), ['C']);
    await db.close();
  });
});

describe('milestone gating', () => {
  async function gatedFixture(db: Database): Promise<void> {
    await new MilestoneStore(db).upsertMilestone({
      id: 'M1',
      project: 'P',
      name: 'M1',
    });
    await new MilestoneStore(db).upsertMilestone({
      id: 'M2',
      project: 'P',
      name: 'M2',
    });
    await addTicket(db, 'T1', 'verified');
    await addTicket(db, 'T2');
    await block(db, 'T1', 'M1'); // T1 is a member of M1
    await block(db, 'T2', 'M2'); // T2 is a member of M2
    await block(db, 'M1', 'M2'); // M2's work waits on M1
  }

  function recordReview(db: Database, members: string[], at: string): void {
    const milestone = db.get(
      "SELECT id FROM node WHERE external_id = 'M1'"
    ) as {id: number};
    db.run('INSERT INTO review (milestone_id, recorded_at) VALUES (?, ?)', [
      milestone.id,
      at,
    ]);
    for (const member of members) {
      db.run(
        'INSERT INTO review_member (milestone_id, member_external_id) VALUES (?, ?)',
        [milestone.id, member]
      );
    }
  }

  it('gates a later milestone member until the earlier milestone is reviewed', async () => {
    const db = await fresh();
    await gatedFixture(db);

    assert.equal(await classificationOf(db, 'T2'), 'blocked');
    const entry = (await classifiedItems(db, {now: NOW})).find(
      (item) => item.item.id === 'T2'
    );
    assert.deepEqual(entry?.gatedBy, ['M1']);

    recordReview(db, ['T1'], NOW);
    assert.deepEqual(await frontierIds(db), ['T2']);
    await db.close();
  });

  it('re-closes the gate when the reviewed member set changes', async () => {
    const db = await fresh();
    await gatedFixture(db);
    recordReview(db, ['T1'], NOW);
    assert.deepEqual(await frontierIds(db), ['T2']);

    await addTicket(db, 'T3', 'available');
    await block(db, 'T3', 'M1');
    assert.equal(await classificationOf(db, 'T2'), 'blocked');
    await db.close();
  });

  it('re-closes the gate when a member moves after the review', async () => {
    const db = await fresh();
    await gatedFixture(db);
    recordReview(db, ['T1'], STALE);
    await addTicket(db, 'T1', 'verified', {updatedAt: NOW});

    assert.equal(await classificationOf(db, 'T2'), 'blocked');
    await db.close();
  });

  it('reports milestone readiness and openness', async () => {
    const db = await fresh();
    await gatedFixture(db);

    const before = await milestoneStates(db, {now: NOW});
    const m1 = before.find((state) => state.id === 'M1');
    assert.equal(m1?.readyForReview, true);
    assert.equal(m1.reviewRecorded, false);
    assert.equal(m1.open, false);

    recordReview(db, ['T1'], NOW);
    const after = await milestoneStates(db, {now: NOW});
    assert.equal(after.find((state) => state.id === 'M1')?.open, true);
    await db.close();
  });
});

describe('claims and passes', () => {
  it('excludes an item under a live claim from the queue', async () => {
    const db = await fresh();
    await addTicket(db, 'A');
    await session(db, 'S1', NOW);
    await claim(db, 'A', 'S1');

    assert.equal(await classificationOf(db, 'A'), 'in-flight');
    assert.deepEqual(await queueOf(db), []);
    await db.close();
  });

  it('re-serves a started ticket under a stale-session claim as resume', async () => {
    const db = await fresh();
    await addTicket(db, 'A', 'in-progress');
    await session(db, 'S1', STALE);
    await claim(db, 'A', 'S1');

    assert.deepEqual(await queueOf(db), [{id: 'A', pass: 'resume'}]);
    await db.close();
  });

  it('re-serves a started ticket with no claim at all as resume', async () => {
    // The stale sweep cascades a dead session's claims away, so a crashed
    // run often leaves only the started status behind.
    const db = await fresh();
    await addTicket(db, 'A', 'in-progress');

    assert.deepEqual(await queueOf(db), [{id: 'A', pass: 'resume'}]);
    await db.close();
  });

  it('re-admits a delivered ticket as verify', async () => {
    const db = await fresh();
    await addTicket(db, 'A', 'delivered');
    await session(db, 'S1', NOW);
    await new CoordinationStore(db).recordOutcome(
      {
        node: 'A',
        outcome: 'delivered',
        retryable: null,
        detail: null,
        recordedAt: NOW,
      },
      {session: 'S1'}
    );

    assert.deepEqual(await queueOf(db), [{id: 'A', pass: 'verify'}]);
    await db.close();
  });

  it('finalizes a decomposed parent only once its subtasks resolve', async () => {
    const db = await fresh();
    await addTicket(db, 'PARENT', 'in-progress');
    await addTicket(db, 'SUB');
    await block(db, 'SUB', 'PARENT');
    await session(db, 'S1', NOW);
    await new CoordinationStore(db).recordOutcome(
      {
        node: 'PARENT',
        outcome: 'decomposed',
        retryable: null,
        detail: null,
        recordedAt: NOW,
      },
      {session: 'S1'}
    );

    assert.deepEqual(await queueOf(db), [{id: 'SUB', pass: null}]);

    await addTicket(db, 'SUB', 'verified');
    assert.deepEqual(await queueOf(db), [{id: 'PARENT', pass: 'finalize'}]);
    await db.close();
  });

  it('re-admits a retryable failure and parks a non-retryable one', async () => {
    const db = await fresh();
    await addTicket(db, 'A');
    await session(db, 'S1', NOW);
    const store = new CoordinationStore(db);
    await store.recordOutcome(
      {
        node: 'A',
        outcome: 'failed',
        retryable: true,
        detail: null,
        recordedAt: NOW,
      },
      {session: 'S1'}
    );
    assert.deepEqual(await queueOf(db), [{id: 'A', pass: 'retry'}]);

    await store.recordOutcome(
      {
        node: 'A',
        outcome: 'failed',
        retryable: false,
        detail: null,
        recordedAt: NOW,
      },
      {session: 'S1'}
    );
    assert.deepEqual(await queueOf(db), []);
    await db.close();
  });
});

describe('bare PRs and ranking', () => {
  it('queues bare and ticket-attached PR items alike', async () => {
    const db = await fresh();
    await addTicket(db, 'T1', 'backlog');
    const prs = new PrStore(db);
    await prs.upsertPr({
      id: 'o/r#7',
      ticket: null,
      origin: 'prompt',
      repo: 'o/r',
      prNumber: 7,
      url: null,
      branch: null,
      title: 'bare',
      injected: false,
      priority: null,
      updatedAt: null,
    });
    await prs.upsertPr({
      id: 'o/r#8',
      ticket: 'T1',
      origin: 'ticket',
      repo: 'o/r',
      prNumber: 8,
      url: null,
      branch: null,
      title: 'attached',
      injected: false,
      priority: null,
      updatedAt: null,
    });

    assert.deepEqual(await queueOf(db), [
      {id: 'o/r#7', pass: null},
      {id: 'o/r#8', pass: null},
    ]);
    const attached = (await classifiedItems(db, {now: NOW})).find(
      (entry) => entry.item.id === 'o/r#8'
    );
    assert.ok(attached);
    assert.equal(attached.item.ticket, 'T1');
    assert.equal(attached.item.project, 'P');
    await db.close();
  });

  it('holds a decomposed ticket while its PR items are open, then finalizes it', async () => {
    const db = await fresh();
    await addTicket(db, 'T1', 'in-progress');
    await new PrStore(db).upsertPr({
      id: 'o/r#9',
      ticket: 'T1',
      origin: 'ticket',
      repo: 'o/r',
      prNumber: null,
      url: null,
      branch: null,
      title: 'the work',
      injected: false,
      priority: null,
      updatedAt: null,
    });
    await block(db, 'o/r#9', 'T1');
    await session(db, 'S1', NOW);
    await new CoordinationStore(db).recordOutcome(
      {
        node: 'T1',
        outcome: 'decomposed',
        retryable: null,
        detail: null,
        recordedAt: NOW,
      },
      {session: 'S1'}
    );

    assert.deepEqual(await queueOf(db), [{id: 'o/r#9', pass: null}]);

    await new CoordinationStore(db).recordOutcome(
      {
        node: 'o/r#9',
        outcome: 'delivered',
        retryable: null,
        detail: null,
        recordedAt: NOW,
      },
      {session: 'S1'}
    );
    assert.deepEqual(await queueOf(db), [{id: 'T1', pass: 'finalize'}]);
    await db.close();
  });

  it('ranks injected work to the head of the frontier', async () => {
    const db = await fresh();
    await addTicket(db, 'A', 'available', {priority: 1});
    await addTicket(db, 'B', 'available', {injected: true});

    assert.deepEqual(await frontierIds(db), ['B', 'A']);
    await db.close();
  });

  it('ranks by fan-out when priority ties', async () => {
    const db = await fresh();
    await addTicket(db, 'A');
    await addTicket(db, 'B');
    await addTicket(db, 'DOWNSTREAM', 'backlog');
    await block(db, 'B', 'DOWNSTREAM');

    assert.deepEqual(await frontierIds(db), ['B', 'A']);
    await db.close();
  });
});

describe('human-owned work', () => {
  it('classifies requires-human and human-only tickets human-blocked, never queued', async () => {
    const db = await fresh();
    await addTicket(db, 'A', 'available', {requiresHuman: true});
    await addTicket(db, 'B', 'available', {targetKind: 'human-only'});
    await addTicket(db, 'C', 'awaiting-external');

    assert.equal(await classificationOf(db, 'A'), 'human-blocked');
    assert.equal(await classificationOf(db, 'B'), 'human-blocked');
    assert.equal(await classificationOf(db, 'C'), 'human-blocked');
    assert.deepEqual(await queueOf(db), []);
    await db.close();
  });
});
