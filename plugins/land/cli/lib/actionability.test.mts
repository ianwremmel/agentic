import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {classifyActionable, hasTerminalSignal} from './actionability.mts';

const CALLER = 'agent-bot';

describe('hasTerminalSignal', () => {
  it('matches a terminal token on the last non-empty line', () => {
    assert.equal(hasTerminalSignal('fixed the thing\n\nDone.'), true);
    assert.equal(hasTerminalSignal('Shipped'), true);
    assert.equal(hasTerminalSignal('✅'), true);
  });

  it('ignores "done" mentioned mid-prose', () => {
    assert.equal(hasTerminalSignal('I am not done yet, still working'), false);
  });
});

describe('classifyActionable', () => {
  it('suppresses a platform-resolved thread', () => {
    const {actionable, reason} = classifyActionable({
      body: 'please fix',
      author: 'reviewer',
      resolved: true,
      callerLogin: CALLER,
    });
    assert.equal(actionable, false);
    assert.equal(reason, 'resolved');
  });

  it("suppresses the caller's own plan/engagement artifact", () => {
    const {actionable, reason} = classifyActionable({
      body: '<!-- agent-engagement:agent-bot -->\nready for review',
      author: CALLER,
      resolved: false,
      callerLogin: CALLER,
    });
    assert.equal(actionable, false);
    assert.equal(reason, 'agent-artifact');
  });

  it('keeps a human quoting the marker actionable (author mismatch)', () => {
    const {actionable} = classifyActionable({
      body: '<!-- agent-engagement:agent-bot -->\nwhy did you do this?',
      author: 'human-reviewer',
      resolved: false,
      callerLogin: CALLER,
    });
    assert.equal(actionable, true);
  });

  it("suppresses the caller's terminal-tagged reply", () => {
    const {actionable, reason} = classifyActionable({
      body: '<!-- agent-reply:agent-bot -->\naddressed in abc123\n\nDone.',
      author: CALLER,
      resolved: false,
      callerLogin: CALLER,
    });
    assert.equal(actionable, false);
    assert.equal(reason, 'agent-terminal-reply');
  });

  it('re-actionables when a reviewer replies after the agent (no terminal tag, other author)', () => {
    const {actionable} = classifyActionable({
      body: 'still not right',
      author: 'reviewer',
      resolved: false,
      callerLogin: CALLER,
    });
    assert.equal(actionable, true);
  });

  it('suppresses a comment the caller reacted to with a terminal reaction', () => {
    const {actionable, reason} = classifyActionable({
      body: 'nice work',
      author: 'operator',
      resolved: false,
      callerLogin: CALLER,
      reactionGroups: [{content: 'ROCKET', viewerHasReacted: true}],
    });
    assert.equal(actionable, false);
    assert.equal(reason, 'agent-terminal-reply');
  });

  it('does not suppress on a non-terminal reaction like eyes', () => {
    const {actionable} = classifyActionable({
      body: 'please look',
      author: 'operator',
      resolved: false,
      callerLogin: CALLER,
      reactionGroups: [{content: 'EYES', viewerHasReacted: true}],
    });
    assert.equal(actionable, true);
  });
});
