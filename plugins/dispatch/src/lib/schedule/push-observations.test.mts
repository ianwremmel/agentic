import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {describe, it} from 'node:test';

import {ChannelWriter} from '../mcp/channel.mts';
import {tempEnv, ticket} from '../command/test-support.mts';
import {withDatabase} from '../db/index.mts';
import {processStartIso} from '../liveness/index.mts';
import {
  CoordinationStore,
  PrStore,
  ProjectStore,
  SessionStore,
  TicketStore,
  WorkerStore,
} from '../stores/index.mts';
import {pushObservations} from './tick.mts';

const NOW = '2026-08-08T12:00:00.000Z';
const SESSION = 'reg-1';

interface Pushed {
  kind: string;
  meta: Record<string, unknown>;
  content: string;
}

function capture(): {channel: ChannelWriter; pushed: Pushed[]} {
  const pushed: Pushed[] = [];
  const channel = new ChannelWriter((payload) => {
    const params = (
      payload as {params: {meta: Record<string, unknown>; content: string}}
    ).params;
    pushed.push({
      kind: String(params.meta.kind),
      meta: params.meta,
      content: params.content,
    });
  });
  return {channel, pushed};
}

async function seed(env: NodeJS.ProcessEnv): Promise<void> {
  await withDatabase(undefined, env, async (db) => {
    await new ProjectStore(db).upsertProject({
      id: 'P',
      name: 'P',
      source: 'linear',
    });
    await new TicketStore(db).upsertTicket(ticket('CLC-1', 'P'));
    await new PrStore(db).upsertPr({
      id: 'o/r#1',
      ticket: 'CLC-1',
      origin: 'ticket',
      repo: 'o/r',
      prNumber: 1,
      url: null,
      branch: 'b',
      title: 't',
      injected: false,
      priority: null,
      updatedAt: NOW,
    });
    await new SessionStore(db).register({
      id: SESSION,
      host: hostname(),
      pid: process.pid,
      claudeSessionId: 'c',
      startedAt: processStartIso(),
      heartbeatAt: new Date().toISOString(),
    });
  });
}

describe('pushObservations meta shaping', () => {
  it('stamps the live worker ref and refuses a producer-supplied agent', async () => {
    const env = await tempEnv();
    await seed(env);
    await withDatabase(undefined, env, async (db) => {
      await new CoordinationStore(db).claim({
        node: 'o/r#1',
        session: SESSION,
        claimedAt: NOW,
      });
      await new WorkerStore(db).set({
        node: 'o/r#1',
        session: SESSION,
        agentRef: 'real-agent',
        at: NOW,
      });
      // A producer smuggling `agent` into meta must not win over the router.
      db.run(
        "INSERT INTO pr_event (node_id, kind, summary, meta, session_id, observed_at) VALUES ((SELECT id FROM node WHERE external_id='o/r#1'), 'pr_review', 'r', ?, ?, ?)",
        [JSON.stringify({state: 'approved', agent: 'forged'}), SESSION, NOW]
      );
    });

    const {channel, pushed} = capture();
    await pushObservations(channel, env, SESSION, NOW);

    assert.equal(pushed.length, 1);
    const [event] = pushed;
    assert.ok(event !== undefined);
    assert.equal(event.meta.agent, 'real-agent');
    assert.equal(event.meta.item, 'o/r#1');
    assert.equal(event.meta.repo, 'o/r');
  });

  it('drains an event whose owning session is gone', async () => {
    const env = await tempEnv();
    await seed(env);
    await withDatabase(undefined, env, async (db) => {
      db.run(
        "INSERT INTO pr_event (node_id, kind, summary, meta, session_id, observed_at) VALUES ((SELECT id FROM node WHERE external_id='o/r#1'), 'watch_expired', 'deadline', '{}', 'gone-1', ?)",
        [NOW]
      );
      await new SessionStore(db).register({
        id: 'reg-2',
        host: hostname(),
        pid: process.pid,
        claudeSessionId: 'c2',
        startedAt: processStartIso(),
        heartbeatAt: new Date().toISOString(),
      });
    });

    // A watch can outlive the session that armed it — six hours of expiry
    // against a server that restarts. Held for a session that will never
    // return, the notice is never read by anyone.
    const {channel, pushed} = capture();
    await pushObservations(channel, env, 'reg-2', NOW);

    assert.equal(pushed.length, 1);
    const [event] = pushed;
    assert.ok(event !== undefined);
    assert.equal(event.kind, 'watch_expired');
    // Nobody live holds the item, so there is no address to relay to and the
    // session cold-starts a resume pass instead.
    assert.equal(event.meta.agent, undefined);
  });

  it('leaves an event undelivered when its render throws, to retry', async () => {
    const env = await tempEnv();
    await seed(env);
    await withDatabase(undefined, env, async (db) => {
      await Promise.resolve();
      // A watching row whose stored snapshot is not valid JSON: latestSnapshot
      // throws, and the event must survive for the next tick.
      db.run(
        `INSERT INTO watch (node_id, state, snapshot, interval_s, session_id, created_at, expires_at)
         VALUES ((SELECT id FROM node WHERE external_id='o/r#1'), 'watching', '{not json', 60, ?, ?, ?)`,
        [SESSION, NOW, '2026-08-08T13:00:00.000Z']
      );
      db.run(
        "INSERT INTO pr_event (node_id, kind, summary, meta, session_id, observed_at) VALUES ((SELECT id FROM node WHERE external_id='o/r#1'), 'ci_finished', 'ci', '{}', ?, ?)",
        [SESSION, NOW]
      );
    });

    const {channel, pushed} = capture();
    await pushObservations(channel, env, SESSION, NOW);

    // Nothing pushed, and the row is still undelivered — not marked and lost.
    assert.equal(pushed.length, 0);
    await withDatabase(undefined, env, async (db) => {
      await Promise.resolve();
      assert.equal(
        Number(
          db.get('SELECT COUNT(*) n FROM pr_event WHERE delivered_at IS NULL')
            ?.n
        ),
        1
      );
    });
  });
});
