import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError} from '../errors.mts';
import {DEFAULT_CONFIG, type GraphConfig} from './config.mts';
import {resolveTask, type TaskInput} from './task-input.mts';

const BASE: TaskInput = {
  id: 'CLC-1',
  project: 'P',
  role: 'available',
  milestone: undefined,
  priority: undefined,
  url: undefined,
  title: undefined,
  labels: undefined,
  branchHint: undefined,
  updatedAt: undefined,
  injected: false,
};

function resolve(
  overrides: Partial<TaskInput>,
  config: GraphConfig = DEFAULT_CONFIG
) {
  return resolveTask({...BASE, ...overrides}, {config});
}

describe('resolving a task from flags', () => {
  it('accepts a protocol role', () => {
    assert.equal(resolve({role: 'in-review'}).role, 'in-review');
  });

  it('derives target-kind and human-interactive from labels, not flags', () => {
    const config: GraphConfig = {
      ...DEFAULT_CONFIG,
      humanInteractiveLabels: ['needs-human'],
      verificationLabels: ['qa'],
    };
    assert.equal(resolve({labels: 'qa'}, config).targetKind, 'verification');
    const human = resolve({labels: 'needs-human'}, config);
    assert.equal(human.targetKind, 'human-only');
    assert.equal(human.humanInteractive, true);
    assert.equal(resolve({labels: 'chore'}, config).humanInteractive, false);
  });

  it('splits comma-separated labels and trims them', () => {
    assert.deepEqual(resolve({labels: 'infra, qa ,'}).labels, ['infra', 'qa']);
  });

  it('parses a numeric priority and treats blank as none', () => {
    assert.equal(resolve({priority: '2'}).priority, 2);
    assert.equal(resolve({priority: ''}).priority, null);
    assert.equal(resolve({priority: undefined}).priority, null);
  });
});

describe('rejecting bad input', () => {
  function rejects(overrides: Partial<TaskInput>, message: RegExp): void {
    assert.throws(
      () => resolve(overrides),
      (error: unknown) => {
        assert.ok(error instanceof DataError);
        assert.match(error.message, message);
        return true;
      }
    );
  }

  it('requires id, project, and role', () => {
    rejects({id: undefined}, /needs --id/);
    rejects({project: undefined}, /needs --project/);
    rejects({role: undefined}, /needs --role/);
  });

  it('rejects a value outside the protocol vocabulary instead of guessing', () => {
    rejects({role: 'Ready for QA'}, /"Ready for QA" is not a protocol role/);
  });

  it('rejects a non-numeric priority', () => {
    rejects({priority: 'high'}, /--priority must be a number/);
  });
});
