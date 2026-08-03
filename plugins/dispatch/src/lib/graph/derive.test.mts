import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ticket as baseTicket} from '../command/test-support.mts';
import {Database} from '../db/database.mts';
import {
  EdgeStore,
  PrStore,
  ProjectStore,
  TicketStore,
} from '../stores/index.mts';
import {derive} from './derive.mts';

const NOW = '2026-08-03T12:00:00.000Z';

async function fresh(): Promise<Database> {
  const db = await Database.open(':memory:');
  await new ProjectStore(db).upsertProject({
    id: 'P',
    name: 'P',
    source: 'linear',
  });
  return db;
}

describe('derive', () => {
  it('goes terminal only when every ticket is resolved', async () => {
    const db = await fresh();
    const tickets = new TicketStore(db);
    await tickets.upsertTicket({...baseTicket('A', 'P'), status: 'verified'});
    await tickets.upsertTicket({...baseTicket('B', 'P'), status: 'backlog'});

    const before = await derive(db, {now: NOW});
    assert.equal(before.terminal, false);
    const beforeCounts = before.counts[0];
    assert.ok(beforeCounts);
    assert.equal(beforeCounts.dormant, 1);

    await tickets.upsertTicket({...baseTicket('B', 'P'), status: 'canceled'});
    const after = await derive(db, {now: NOW});
    assert.equal(after.terminal, true);
    const afterCounts = after.counts[0];
    assert.ok(afterCounts);
    assert.equal(afterCounts.verified, 1);
    assert.equal(afterCounts.canceled, 1);
    await db.close();
  });

  it('keeps an open bare PR from a terminal verdict', async () => {
    const db = await fresh();
    await new TicketStore(db).upsertTicket({
      ...baseTicket('A', 'P'),
      status: 'verified',
    });
    await new PrStore(db).upsertPr({
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

    const graph = await derive(db, {now: NOW});
    assert.equal(graph.projects[0]?.terminal, true);
    assert.equal(graph.terminal, false);
    assert.equal(graph.prs[0]?.classification, 'available');
    await db.close();
  });

  it('reports a dangling edge as an anomaly', async () => {
    const db = await fresh();
    await new TicketStore(db).upsertTicket(baseTicket('A', 'P'));
    await new EdgeStore(db).addEdge('GHOST', 'A');

    const graph = await derive(db, {now: NOW});
    const anomaly = graph.anomalies[0];
    assert.ok(anomaly);
    assert.equal(anomaly.kind, 'dangling-edge');
    assert.deepEqual(anomaly.nodes, ['GHOST', 'A']);
    await db.close();
  });

  it('reports mutually blocking projects', async () => {
    const db = await fresh();
    await new ProjectStore(db).upsertProject({
      id: 'Q',
      name: 'Q',
      source: 'linear',
    });
    const tickets = new TicketStore(db);
    await tickets.upsertTicket(baseTicket('A', 'P'));
    await tickets.upsertTicket(baseTicket('B', 'Q'));
    await tickets.upsertTicket(baseTicket('C', 'P'));
    const edges = new EdgeStore(db);
    await edges.addEdge('A', 'B');
    await edges.addEdge('B', 'C');

    const graph = await derive(db, {now: NOW});
    assert.equal(graph.anomalies[0]?.kind, 'cross-project-reverse');
    await db.close();
  });
});

describe('derive with a project filter', () => {
  it('scopes projects, milestones, and the verdict to the selection', async () => {
    const db = await fresh();
    await new ProjectStore(db).upsertProject({
      id: 'Q',
      name: 'Q',
      source: 'linear',
    });
    const tickets = new TicketStore(db);
    await tickets.upsertTicket({...baseTicket('A', 'P'), status: 'verified'});
    await tickets.upsertTicket(baseTicket('B', 'Q'));

    const graph = await derive(db, {now: NOW, project: 'P'});
    assert.deepEqual(
      graph.projects.map((project) => project.id),
      ['P']
    );
    assert.equal(graph.counts.length, 1);
    assert.equal(graph.terminal, true, 'open work in Q must not leak into P');
    await db.close();
  });
});
