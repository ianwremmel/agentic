import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {AbstractCommand} from './abstract-command.mts';
import {resolveTransports} from './transports.mts';

class Base extends AbstractCommand {
  readonly name = 'x';
  readonly summary = 's';
  readonly env = [];
  readonly options = {} as const;
  run(): Promise<void> {
    return Promise.resolve();
  }
}

class NoMcp extends Base {
  override readonly transports = {mcp: false} as const;
}

describe('resolveTransports', () => {
  it('defaults both transports to available', () => {
    assert.deepEqual(resolveTransports(new Base()), {cli: true, mcp: true});
  });

  it('keeps the unstated side available when one opts out', () => {
    assert.deepEqual(resolveTransports(new NoMcp()), {cli: true, mcp: false});
  });
});
