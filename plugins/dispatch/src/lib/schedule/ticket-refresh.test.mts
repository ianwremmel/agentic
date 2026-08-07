import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ticket as baseTicket} from '../command/test-support.mts';
import {Database} from '../db/database.mts';
import {ProjectStore, SessionStore, TicketStore} from '../stores/index.mts';
import {Scheduler} from './scheduler.mts';

const NOW = '2026-08-07T12:00:00.000Z';
/** Four minutes on: inside the in-flight cadence, outside nothing. */
const SOON = '2026-08-07T12:04:00.000Z';
/** Six minutes on: past the in-flight cadence, inside the parked one. */
const LATER = '2026-08-07T12:06:00.000Z';
/** Twenty minutes on: past every cadence. */
const MUCH_LATER = '2026-08-07T12:20:00.000Z';

async function fixture(
  status: string
): Promise<{db: Database; scheduler: Scheduler}> {
  const db = await Database.open(':memory:');
  await new ProjectStore(db).upsertProject({
    id: 'P',
    name: 'P',
    source: 'linear',
  });
  await new TicketStore(db).upsertTicket({
    ...baseTicket('T1', 'P'),
    status: status as never,
  });
  const sessions = new SessionStore(db);
  await sessions.register({
    id: 'S1',
    startedAt: NOW,
    heartbeatAt: NOW,
    claudeSessionId: 'c1',
  });
  await sessions.ack('S1', 'c1', NOW);
  return {db, scheduler: new Scheduler(db, {session: 'S1'})};
}

function openRefreshes(db: Database): number {
  // Open = unresolved, not undelivered: a delivered-but-unanswered ask is
  // still outstanding, and the dedupe keys on that.
  return Number(
    db.get(
      "SELECT COUNT(*) n FROM fetch_request WHERE kind='refresh_ticket' AND resolution IS NULL"
    )?.n ?? 0
  );
}

describe('ticket refresh scheduling', () => {
  it('asks about an in-flight ticket once per cadence, not per tick', async () => {
    const {db, scheduler} = await fixture('in-progress');
    await scheduler.tick(NOW);
    assert.equal(openRefreshes(db), 1);

    // Answer it, then tick inside the cadence: no new ask.
    await new TicketStore(db).upsertTicket({
      ...baseTicket('T1', 'P'),
      status: 'in-progress',
    });
    await scheduler.tick(SOON);
    assert.equal(openRefreshes(db), 0);

    // Past the cadence: asked again.
    await scheduler.tick(LATER);
    assert.equal(openRefreshes(db), 1);
    await db.close();
  });

  it('keeps one ask open per ticket, however many ticks pass', async () => {
    const {db, scheduler} = await fixture('in-progress');
    await scheduler.tick(NOW);
    await scheduler.tick(MUCH_LATER);
    // The first ask is still unanswered; piling on a second would make the
    // session fetch the same ticket twice for one staleness.
    assert.equal(openRefreshes(db), 1);
    await db.close();
  });

  it('asks about a parked ticket on the slower cadence', async () => {
    const {db, scheduler} = await fixture('awaiting-external');
    await scheduler.tick(NOW);
    assert.equal(openRefreshes(db), 1);
    await new TicketStore(db).upsertTicket({
      ...baseTicket('T1', 'P'),
      status: 'awaiting-external',
    });
    // Six minutes is past the in-flight cadence but inside the parked one.
    await scheduler.tick(LATER);
    assert.equal(openRefreshes(db), 0);
    await scheduler.tick(MUCH_LATER);
    assert.equal(openRefreshes(db), 1);
    await db.close();
  });

  it('never asks about a backlog or terminal ticket', async () => {
    for (const status of ['backlog', 'verified', 'canceled', 'available']) {
      const {db, scheduler} = await fixture(status);
      await scheduler.tick(NOW);
      assert.equal(openRefreshes(db), 0, status);
      await db.close();
    }
  });
});

describe('ticket set answering a refresh', () => {
  it('resolves the ask and emits an event only on a real transition', async () => {
    const {db, scheduler} = await fixture('in-progress');
    await scheduler.tick(NOW);

    // A rewrite with the same status answers the ask but says nothing.
    await new TicketStore(db).upsertTicket({
      ...baseTicket('T1', 'P'),
      status: 'in-progress',
    });
    assert.equal(openRefreshes(db), 0);
    assert.equal(
      Number(
        db.get("SELECT COUNT(*) n FROM pr_event WHERE kind='ticket_changed'")?.n
      ),
      0
    );

    // A transition — the park ending — is the tracker speaking, and pushes.
    await new TicketStore(db).upsertTicket({
      ...baseTicket('T1', 'P'),
      status: 'available',
    });
    const event = db.get(
      "SELECT summary, meta FROM pr_event WHERE kind='ticket_changed'"
    );
    assert.match(String(event?.summary), /in-progress -> available/u);
    assert.equal(
      (JSON.parse(String(event?.meta)) as {to: string}).to,
      'available'
    );
    await db.close();
  });
});

describe('refresh asks for tickets the tracker lost', () => {
  it('is resolved by ticket missing instead of looping forever', async () => {
    const {db, scheduler} = await fixture('in-progress');
    await scheduler.tick(NOW);
    assert.equal(openRefreshes(db), 1);

    // The drain's own instruction tells the session to report a vanished
    // ticket missing; if that cannot resolve a refresh ask, the open row
    // suppresses every future ask and redelivers forever.
    const {RefreshService} = await import('../refresh/index.mts');
    await new RefreshService(db).markMissing('T1');
    assert.equal(openRefreshes(db), 0);
    await db.close();
  });

  it('keeps at most one history row per answered ticket', async () => {
    const {db, scheduler} = await fixture('in-progress');
    for (const at of [NOW, LATER, MUCH_LATER]) {
      await scheduler.tick(at);
      await new TicketStore(db).upsertTicket({
        ...baseTicket('T1', 'P'),
        status: 'in-progress',
      });
    }
    // Three ask/answer rounds must not leave three rows: the history only
    // carries the newest ask time for the cadence.
    assert.equal(
      Number(
        db.get(
          "SELECT COUNT(*) n FROM fetch_request WHERE kind='refresh_ticket'"
        )?.n
      ),
      1
    );
    await db.close();
  });
});
