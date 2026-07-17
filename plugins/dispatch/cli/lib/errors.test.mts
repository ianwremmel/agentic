import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  DataError,
  DispatchError,
  ensure,
  EnvironmentError,
  TaggedUsageError,
  UsageError,
} from './errors.mts';

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

  it('renders details after the message and before the cause', () => {
    const error = new EnvironmentError('cannot open the dispatch database', {
      details: {path: '/tmp/x.db'},
      cause: new Error('disk I/O error'),
    });

    assert.equal(
      error.toString(),
      'cannot open the dispatch database (path=/tmp/x.db): disk I/O error'
    );
  });

  it('renders a cause that cannot stringify instead of throwing', () => {
    // String() throws on a null-prototype object; the failure report must not.
    const error = new DispatchError('store failed', {
      cause: Object.create(null) as unknown,
    });

    assert.equal(error.toString(), 'store failed: [object Object]');
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

describe('TaggedUsageError.toString', () => {
  it('renders the tagged usage under the message', () => {
    const error = new TaggedUsageError('unknown flag "--bogus"', {
      usage: 'dispatch greet <name>',
    });

    assert.equal(
      error.toString(),
      'unknown flag "--bogus"\n\nusage: dispatch greet <name>'
    );
  });

  it('keeps details in the rendered failure', () => {
    const error = new TaggedUsageError('flag rejected', {
      details: {flag: '--stale-after'},
      usage: 'dispatch graph claim <id>',
    });

    assert.equal(
      error.toString(),
      'flag rejected (flag=--stale-after)\n\nusage: dispatch graph claim <id>'
    );
  });

  it('does not repeat a re-tagged message through its cause', () => {
    // The runner and subcommand groups wrap a UsageError into a
    // TaggedUsageError, keeping the original as the cause. The message already
    // carries over, so appending the cause the way the base DispatchError does
    // would print it twice.
    const original = new UsageError('unknown flag "--bogus"');
    const retagged = new TaggedUsageError(original.message, {
      cause: original,
      usage: 'dispatch greet <name>',
    });

    assert.equal(
      retagged.toString(),
      'unknown flag "--bogus"\n\nusage: dispatch greet <name>'
    );
  });
});

describe('details across retagging', () => {
  it('survive the wrap into a TaggedUsageError, the way the runner retags', () => {
    const original = new UsageError('flag rejected', {
      details: {flag: '--stale-after'},
    });
    const retagged = new TaggedUsageError(original.message, {
      cause: original,
      usage: 'dispatch graph claim <id>',
      ...(original.details === undefined ? {} : {details: original.details}),
    });

    assert.equal(
      retagged.toString(),
      'flag rejected (flag=--stale-after)\n\nusage: dispatch graph claim <id>'
    );
  });

  it('render nothing for an empty details object', () => {
    assert.equal(
      new DispatchError('plain failure', {details: {}}).toString(),
      'plain failure'
    );
  });
});

describe('ensure', () => {
  it('never constructs the error while the condition holds', () => {
    let built = 0;
    ensure(true, () => {
      built += 1;
      return new DataError('never thrown');
    });

    assert.equal(built, 0);
  });

  it('throws exactly the error the factory built', () => {
    const error = new DataError('bad payload');

    assert.throws(
      () => {
        ensure(false, () => error);
      },
      (thrown: unknown) => thrown === error
    );
  });
});
