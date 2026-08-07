import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {describe, it} from 'node:test';

import {tempEnv, ticket} from '../src/lib/command/test-support.mts';
import {withDatabase} from '../src/lib/db/index.mts';
import {processStartIso} from '../src/lib/liveness/index.mts';
import {
  CoordinationStore,
  ProjectStore,
  SessionStore,
  TicketStore,
} from '../src/lib/stores/index.mts';

const HOOK = new URL('./claim-guard.mts', import.meta.url).pathname;
const CALLER = 'claude-hook-test';

async function fixture(claimed: boolean): Promise<NodeJS.ProcessEnv> {
  const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: CALLER};
  await withDatabase(undefined, env, async (db) => {
    await new ProjectStore(db).upsertProject({
      id: 'P',
      name: 'P',
      source: 'linear',
    });
    await new TicketStore(db).upsertTicket(ticket('CLC-77', 'P'));
    await new SessionStore(db).register({
      id: 'S1',
      host: hostname(),
      pid: process.pid,
      claudeSessionId: CALLER,
      startedAt: processStartIso(),
      heartbeatAt: new Date().toISOString(),
    });
    if (claimed) {
      await new CoordinationStore(db).claim({
        node: 'CLC-77',
        session: 'S1',
        claimedAt: new Date().toISOString(),
      });
    }
  });
  return env;
}

/** Run the hook with a payload on stdin and return its verdict. */
function hook(
  env: NodeJS.ProcessEnv,
  payload: unknown
): Promise<{decision: string | null; reason: string}> {
  return new Promise((resolve, reject) => {
    const child = (async () => {
      const {spawn} = await import('node:child_process');
      const proc = spawn('node', [HOOK], {env: {...process.env, ...env}});
      let out = '';
      proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
      proc.on('error', reject);
      proc.on('close', () => {
        if (out.trim() === '') {
          resolve({decision: null, reason: ''});
          return;
        }
        const parsed = JSON.parse(out) as {
          hookSpecificOutput?: {
            permissionDecision?: string;
            permissionDecisionReason?: string;
          };
        };
        resolve({
          decision: parsed.hookSpecificOutput?.permissionDecision ?? null,
          reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? '',
        });
      });
      proc.stdin.end(JSON.stringify(payload));
    })();
    void child;
  });
}

describe('claim-guard hook', () => {
  it('allows a worker launch whose prompt names a claimed node', async () => {
    const env = await fixture(true);
    const verdict = await hook(env, {
      tool_input: {
        subagent_type: 'dispatch:ticket-worker',
        prompt: 'Coordinate ticket CLC-77 (pass: available).',
      },
    });
    assert.equal(verdict.decision, null);
  });

  it('denies a worker launch for an unclaimed node', async () => {
    // The incident shape: a session composes launches from the queue instead
    // of executing work orders. The harness, not the agent, refuses.
    const env = await fixture(false);
    const verdict = await hook(env, {
      tool_input: {
        subagent_type: 'dispatch:ticket-worker',
        prompt: 'Coordinate ticket CLC-77 (pass: available).',
      },
    });
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /work order/u);
  });

  it('denies a worker launch whose prompt names nothing claimed', async () => {
    const env = await fixture(true);
    const verdict = await hook(env, {
      tool_input: {
        subagent_type: 'dispatch:pr-worker',
        prompt: 'Implement something I decided on my own.',
      },
    });
    assert.equal(verdict.decision, 'deny');
  });

  it('ignores non-worker agent launches', async () => {
    const env = await fixture(false);
    const verdict = await hook(env, {
      tool_input: {
        subagent_type: 'general-purpose',
        prompt: 'Anything at all.',
      },
    });
    assert.equal(verdict.decision, null);
  });

  it('passes through on a malformed payload', async () => {
    // Unreadable input gives no way to tell a worker launch from anything
    // else; failing closed would break every tool call in the session.
    const env = await fixture(false);
    const verdict = await new Promise<{decision: string | null}>(
      (resolve, reject) => {
        void (async () => {
          const {spawn} = await import('node:child_process');
          const proc = spawn('node', [HOOK], {env: {...process.env, ...env}});
          let out = '';
          proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
          proc.on('error', reject);
          proc.on('close', () => {
            resolve({decision: out.trim() === '' ? null : 'deny'});
          });
          proc.stdin.end('not json');
        })();
      }
    );
    assert.equal(verdict.decision, null);
  });
});

describe('claim-guard hook boundaries', () => {
  it('does not let a claim on a prefix authorize a longer id', async () => {
    // CLC-77 is claimed; CLC-777 is not. Substring matching would pass this.
    const env = await fixture(true);
    const verdict = await hook(env, {
      tool_input: {
        subagent_type: 'dispatch:ticket-worker',
        prompt: 'Coordinate ticket CLC-777 (pass: available).',
      },
    });
    assert.equal(verdict.decision, 'deny');
  });

  it('passes through a null payload like a malformed one', async () => {
    const env = await fixture(false);
    const verdict = await hook(env, null);
    assert.equal(verdict.decision, null);
  });
});
