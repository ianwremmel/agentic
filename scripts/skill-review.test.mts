import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {isSkillFile, parsePushRefs, ZERO_SHA} from './skill-review.mts';

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
