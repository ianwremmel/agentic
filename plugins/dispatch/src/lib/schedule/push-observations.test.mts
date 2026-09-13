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
const RELAY_AT = '2026-08-08T12:05:00.000Z';
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
    // This worker never yielded, so the relay only refreshed a claim it
    // already held. Naming that claim would hand the session a token for a
    // turn still executing, which the handover would then accept.
    assert.equal(event.meta.turn, undefined);
  });

  it('lets no producer forge the routing keys on an unrelayed event', async () => {
    const env = await tempEnv();
    await seed(env);
    await withDatabase(undefined, env, (db) => {
      // No worker row, so nothing relays and the router has nothing of its
      // own to stamp. The reserved keys must still not come from the payload.
      db.run(
        "INSERT INTO pr_event (node_id, kind, summary, meta, session_id, observed_at) VALUES ((SELECT id FROM node WHERE external_id='o/r#1'), 'pr_review', 'r', ?, ?, ?)",
        [JSON.stringify({agent: 'forged', turn: 'whenever'}), SESSION, NOW]
      );
    });

    const {channel, pushed} = capture();
    await pushObservations(channel, env, SESSION, NOW);

    const [event] = pushed;
    assert.ok(event !== undefined);
    assert.equal(event.meta.agent, undefined);
    assert.equal(event.meta.turn, undefined);
  });

  it('re-takes the claim when it relays to a live worker', async () => {
    // The worker gave its claim back at `pr yield` so the watch could arm. Its
    // terminal act — recording the outcome — needs one, and a relayed event is
    // the instruction to perform it, so the address and the authority to use it
    // have to travel together.
    const env = await tempEnv();
    await seed(env);
    await withDatabase(undefined, env, async (db) => {
      const coordination = new CoordinationStore(db);
      await coordination.claim({
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
      // `pr yield`: the claim goes back so the watch can arm, and the worker
      // address stays behind as the relay target.
      await coordination.release('o/r#1', SESSION);
      db.run(
        "INSERT INTO pr_event (node_id, kind, summary, meta, session_id, observed_at) VALUES ((SELECT id FROM node WHERE external_id='o/r#1'), 'pr_state_change', 'The PR merged.', ?, ?, ?)",
        [JSON.stringify({state: 'merged'}), SESSION, NOW]
      );
    });

    const {channel, pushed} = capture();
    // Relaying at an instant of its own, distinct from the released claim and
    // from the event's own `observed_at`, so `turn` can only match if it is
    // the claim this relay took.
    await pushObservations(channel, env, SESSION, RELAY_AT);

    assert.equal(pushed.length, 1);
    assert.equal(pushed[0]?.meta.agent, 'real-agent');
    assert.equal(pushed[0].meta.turn, RELAY_AT);
    await withDatabase(undefined, env, async (db) => {
      const held = await new CoordinationStore(db).claims();
      assert.deepEqual(
        held.map((c) => [c.node, c.session]),
        [['o/r#1', SESSION]]
      );
      // The session hands that turn straight back when this agent returns, so
      // it has to be the token the handover accepts — otherwise a worker that
      // died mid-turn keeps its item pinned out of the queue.
      assert.equal(
        await new WorkerStore(db).remove('o/r#1', SESSION, {turn: RELAY_AT}),
        'removed'
      );
    });
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
