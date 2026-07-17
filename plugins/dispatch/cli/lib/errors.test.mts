import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DispatchError, UsageError} from './errors.mts';

describe('DispatchError.toString', () => {
  it('appends the wrapped cause message so the printed failure keeps it', () => {
    const error = new DispatchError('cannot read the file', {
      cause: new Error('EACCES: permission denied'),
    });

    assert.equal(
      error.toString(),
      'cannot read the file: EACCES: permission denied'
    );
  });

  it('stringifies a non-Error cause', () => {
    const error = new DispatchError('parse failed', {cause: 'boom'});

    assert.equal(error.toString(), 'parse failed: boom');
  });

  it('renders every link of a nested cause chain', () => {
    const error = new DispatchError('sync failed', {
      cause: new Error('fetch failed', {cause: new Error('ECONNREFUSED')}),
    });

    assert.equal(error.toString(), 'sync failed: fetch failed: ECONNREFUSED');
  });

  it('survives a cyclic cause chain instead of hanging', () => {
    const inner = new Error('loop');
    inner.cause = inner;
    const error = new DispatchError('outer failure', {cause: inner});

    assert.equal(error.toString(), 'outer failure: loop');
  });

  it('is just the message when nothing was wrapped', () => {
    assert.equal(
      new DispatchError('plain failure').toString(),
      'plain failure'
    );
  });
});

describe('UsageError.toString', () => {
  it('renders the tagged usage under the message', () => {
    const error = new UsageError('unknown flag "--bogus"', {
      usage: 'dispatch greet <name>',
    });

    assert.equal(
      error.toString(),
      'unknown flag "--bogus"\n\nusage: dispatch greet <name>'
    );
  });

  it('does not repeat a re-tagged message through its cause', () => {
    // The runner and subcommand groups rewrap a UsageError to attach a usage,
    // keeping the original as the cause. The message already carries over, so
    // appending the cause the way the base class does would print it twice.
    const original = new UsageError('unknown flag "--bogus"');
    const retagged = new UsageError(original.message, {
      cause: original,
      usage: 'dispatch greet <name>',
    });

    assert.equal(
      retagged.toString(),
      'unknown flag "--bogus"\n\nusage: dispatch greet <name>'
    );
  });
});
