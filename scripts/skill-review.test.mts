import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  isSkillFile,
  mapWithConcurrency,
  parsePushRefs,
  verdictFrom,
  ZERO_SHA,
} from './skill-review.mts';

describe('parsePushRefs', () => {
  it('parses standard pre-push lines', () => {
    const input = [
      `refs/heads/main aa11 refs/heads/main bb22`,
      `refs/heads/topic cc33 refs/heads/topic ${ZERO_SHA}`,
    ].join('\n');

    assert.deepEqual(parsePushRefs(input), [
      {
        localRef: 'refs/heads/main',
        localSha: 'aa11',
        remoteRef: 'refs/heads/main',
        remoteSha: 'bb22',
      },
      {
        localRef: 'refs/heads/topic',
        localSha: 'cc33',
        remoteRef: 'refs/heads/topic',
        remoteSha: ZERO_SHA,
      },
    ]);
  });

  it('drops blank and malformed lines', () => {
    const input = '\n\nnot a ref\nrefs/heads/a b c d e\n';

    assert.deepEqual(parsePushRefs(input), []);
  });

  it('returns no refs for empty input', () => {
    assert.deepEqual(parsePushRefs(''), []);
  });
});

describe('isSkillFile', () => {
  it('matches SKILL.md and companion docs inside a skills tree', () => {
    assert.ok(isSkillFile('plugins/dispatch/skills/deliver/SKILL.md'));
    assert.ok(isSkillFile('plugins/dispatch/skills/deliver/reference.md'));
    assert.ok(isSkillFile('plugins/other/skills/foo/nested/notes.md'));
  });

  it('rejects markdown outside a skills tree', () => {
    assert.ok(!isSkillFile('plugins/dispatch/README.md'));
    assert.ok(!isSkillFile('docs/design.md'));
    assert.ok(!isSkillFile('CLAUDE.md'));
    assert.ok(!isSkillFile('.claude/agents/skill-reviewer.md'));
  });

  it('rejects non-markdown inside a skills tree', () => {
    assert.ok(
      !isSkillFile('plugins/dispatch/skills/deliver/scripts/pr-status')
    );
  });
});

describe('verdictFrom', () => {
  it('passes when the last non-empty line is VERDICT: pass', () => {
    assert.equal(verdictFrom('Already tight.\n\nVERDICT: pass\n\n'), 'pass');
  });

  it('passes when advisory findings precede VERDICT: pass', () => {
    assert.equal(verdictFrom('1. [advisory] Cut X.\nVERDICT: pass\n'), 'pass');
  });

  it('blocks on VERDICT: block', () => {
    assert.equal(
      verdictFrom('1. [must-fix] Fix X.\nVERDICT: block\n'),
      'block'
    );
  });

  it('fails closed when the verdict line is missing or malformed', () => {
    assert.equal(verdictFrom('Looks fine to me!'), 'block');
    assert.equal(verdictFrom('VERDICT: pass\ntrailing chatter'), 'block');
    assert.equal(verdictFrom('1. Cut X.\nVERDICT: findings\n'), 'block');
    assert.equal(verdictFrom(''), 'block');
  });
});

describe('mapWithConcurrency', () => {
  /** Resolves once `release` is called; lets a test pin tasks in flight. */
  function deferred(): {promise: Promise<void>; release: () => void} {
    const handle: {resolve?: () => void} = {};
    const promise = new Promise<void>((resolve) => {
      handle.resolve = resolve;
    });
    return {
      promise,
      release: () => {
        handle.resolve?.();
      },
    };
  }

  it('returns results in input order when tasks finish out of order', async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const gates = [first, second, third];
    const run = mapWithConcurrency([0, 1, 2], 3, async (index) => {
      await gates[index]?.promise;
      return index * 10;
    });
    // Finish last-to-first: order must come from the input, not completion.
    third.release();
    second.release();
    first.release();
    assert.deepEqual(await run, [0, 10, 20]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({length: 20}, (_, i) => i),
      4,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return null;
      }
    );
    assert.equal(peak, 4);
  });

  it('starts a queued task as soon as any worker frees up', async () => {
    // With batching, item 2 would wait for the slow item 0. With a shared
    // cursor it starts the moment item 1 finishes.
    const slow = deferred();
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2], 2, async (index) => {
      started.push(index);
      if (index === 0) {
        await slow.promise;
      }
      return index;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [0, 1, 2]);
    slow.release();
    await run;
  });

  it('does no work and spawns no workers for an empty list', async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, () => {
      calls += 1;
      return Promise.resolve(null);
    });
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });
});
