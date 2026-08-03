import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  DispatchError,
  CommandError,
  UsageError,
  EnvironmentError,
  DefinitionError,
  assertUsage,
  ensure,
} from './index.mts';

describe('error taxonomy', () => {
  it('DispatchError renders its message', () => {
    assert.match(new DispatchError('boom').toString(), /boom/);
  });

  it('renders a hint on its own line', () => {
    const error = new DispatchError('boom', {hint: 'do the thing'});
    assert.match(error.toString(), /hint: do the thing/);
  });

  it('CommandError defaults to exit 1', () => {
    assert.equal(new CommandError('boom').exitCode, 1);
  });

  it('assigns an exit code per command subclass', () => {
    assert.equal(new UsageError('x').exitCode, 2);
    assert.equal(new EnvironmentError('x').exitCode, 3);
    assert.equal(new DefinitionError('x').exitCode, 1);
  });

  it('command subclasses are CommandError and DispatchError instances', () => {
    const usage = new UsageError('x');
    assert.ok(usage instanceof CommandError);
    assert.ok(usage instanceof DispatchError);
    assert.equal(usage.name, 'UsageError');
  });

  it('assertUsage throws a UsageError when the condition is falsy', () => {
    assert.throws(() => {
      assertUsage(false, 'bad flag');
    }, UsageError);
    assert.doesNotThrow(() => {
      assertUsage(true, 'unused');
    });
  });

  it('ensure builds the error lazily, only on failure', () => {
    let built = 0;
    ensure(true, () => {
      built += 1;
      return new DispatchError('unused');
    });
    assert.equal(built, 0);
    assert.throws(() => {
      ensure(false, () => new DefinitionError('nope'));
    }, DefinitionError);
  });
});
