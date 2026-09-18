import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {LinearClient} from '../linear/index.mts';
import type {GraphqlExecutor} from '../linear/index.mts';
import type {FetchRequest} from '../stores/index.mts';
import {answerNatively, canAnswerNatively} from './native.mts';

const KEY = {LINEAR_API_KEY: 'lin_api_test'};

const SCAN: FetchRequest = {
  id: 1,
  source: 'linear',
  kind: 'scan_project',
  payload: {projects: ['P'], cursor: null},
  createdAt: '2026-09-12T00:00:00.000Z',
  deliveredAt: null,
  resolution: null,
};

/** An executor that never answers, so only the gating decides the outcome. */
const unreachable = (() => {
  throw new Error('linear was read when it should not have been');
}) as GraphqlExecutor;

describe('canAnswerNatively', () => {
  it('needs both a tracker with a client and the key to use it', () => {
    assert.equal(canAnswerNatively('linear', KEY), true);
    assert.equal(canAnswerNatively('linear', {}), false);
    assert.equal(canAnswerNatively('linear', {LINEAR_API_KEY: '  '}), false);
    assert.equal(canAnswerNatively('jira', KEY), false);
  });
});

describe('answerNatively', () => {
  it('reads nothing for a tracker it holds no client for', async () => {
    const db = await Database.open(':memory:');
    assert.equal(
      await answerNatively({
        db,
        request: {...SCAN, source: 'jira'},
        env: KEY,
        client: new LinearClient(unreachable),
      }),
      false
    );
    await db.close();
  });

  it('reads nothing when the key is absent, rather than failing on the first call', async () => {
    const db = await Database.open(':memory:');
    assert.equal(
      await answerNatively({
        db,
        request: SCAN,
        env: {},
        client: new LinearClient(unreachable),
      }),
      false
    );
    await db.close();
  });

  it('turns a failed read into the agent fallback, carrying the hint to the log', async () => {
    const db = await Database.open(':memory:');
    const logged: Record<string, unknown>[] = [];
    const log = {
      error: (_message: string, meta?: Record<string, unknown>) => {
        logged.push(meta ?? {});
      },
    };

    assert.equal(
      await answerNatively({
        db,
        request: SCAN,
        env: KEY,
        // A blank endpoint answer: the project selector resolves to nothing,
        // which is the DataError shape a real unmapped scan also takes.
        client: new LinearClient((() =>
          Promise.resolve({
            projects: {nodes: [], pageInfo: {hasNextPage: false}},
          })) as unknown as GraphqlExecutor),
        log: log as never,
      }),
      false
    );
    // Without the hint the agent gets a generic scan instruction and no idea
    // what the server could not do.
    assert.equal(typeof logged[0]?.hint, 'string');
    await db.close();
  });
});
