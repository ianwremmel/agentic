import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {discover} from './lib/command/index.mts';
import {runCli} from './lib/cli/index.mts';
import {createLogger, type CoreLogger} from './lib/logger/index.mts';

const COMMANDS = new URL('./commands/', import.meta.url);

describe('src/commands tree', () => {
  it('discovers and runs the greet command', async () => {
    const tree = await discover(COMMANDS);
    const lines: string[] = [];
    const sink = {} as CoreLogger;
    for (const level of [
      'error',
      'warn',
      'info',
      'debug',
      'trace',
      'log',
    ] as const) {
      sink[level] = (message: string) => {
        lines.push(message);
      };
    }
    const noop = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const code = await runCli({
      argv: ['greet', 'Ada', '--loud'],
      tree,
      log: createLogger(sink),
      env: {},
      stdout: noop,
      stderr: noop,
    });

    assert.equal(code, 0);
    assert.deepEqual(lines, ['HELLO ADA']);
  });
});
