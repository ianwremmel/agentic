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
    const sink = {} as CoreLogger;
    for (const level of [
      'error',
      'warn',
      'info',
      'debug',
      'trace',
      'log',
    ] as const) {
      sink[level] = () => {
        // no-op: greet's output goes to stdout via io, not the logger
      };
    }
    const noop = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const out: string[] = [];
    const sink2 = new Writable({
      write(chunk, _encoding, callback) {
        out.push(String(chunk));
        callback();
      },
    });

    const code = await runCli({
      argv: ['greet', 'Ada', '--loud'],
      tree,
      log: createLogger(sink),
      env: {},
      stdout: sink2,
      stderr: noop,
    });

    assert.equal(code, 0);
    assert.equal(out.join(''), 'HELLO ADA\n');
  });

  it('discovers the mcp command but excludes it from the generated tools', async () => {
    const {buildTools} = await import('./lib/mcp/index.mts');
    const tree = await discover(COMMANDS);
    assert.ok(tree.children.has('mcp'), 'the mcp command is discovered');
    const {byName} = buildTools(tree);
    assert.ok(!byName.has('mcp'), 'but it opts out of its own transport');
    assert.ok(byName.has('greet'));
  });
});
