import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  DispatchError,
  UsageError,
  EnvironmentError,
  DefinitionError,
  assertUsage,
  ensure,
} from './index.mts';

describe('error taxonomy', () => {
  it('DispatchError defaults to exit 1 and renders its message', () => {
    const error = new DispatchError('boom');
    assert.equal(error.exitCode, 1);
    assert.match(error.toString(), /boom/);
  });

  it('renders a hint on its own line', () => {
    const error = new DispatchError('boom', {hint: 'do the thing'});
    assert.match(error.toString(), /hint: do the thing/);
  });

  it('assigns an exit code per subclass', () => {
    assert.equal(new UsageError('x').exitCode, 2);
    assert.equal(new EnvironmentError('x').exitCode, 3);
    assert.equal(new DefinitionError('x').exitCode, 1);
  });

  it('subclasses are DispatchError instances with their own name', () => {
    const usage = new UsageError('x');
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
