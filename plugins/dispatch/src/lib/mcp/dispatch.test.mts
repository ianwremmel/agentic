import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {AbstractCommand} from '../command/index.mts';
import type {ParsedOptions, CommandContext} from '../command/index.mts';
import {createLogger, type CoreLogger} from '../logger/index.mts';
import {callTool} from './dispatch.mts';

const nullLog = () => {
  const noop = () => undefined;
  const sink = {} as CoreLogger;
  for (const level of [
    'error',
    'warn',
    'info',
    'debug',
    'trace',
    'log',
  ] as const) {
    sink[level] = noop;
  }
  return createLogger(sink);
};

const echoOptions = {
  msg: {type: 'string', description: 'd', positional: false, required: true},
} as const;

class Echo extends AbstractCommand {
  readonly name = 'echo';
  readonly summary = 's';
  readonly env = [];
  readonly options = echoOptions;
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    parsed: ParsedOptions<typeof echoOptions>,
    ctx: CommandContext
  ): Promise<void> {
    ctx.io.write(`echo ${parsed.msg}`);
  }
}

class NeedsEnv extends AbstractCommand {
  readonly name = 'needs';
  readonly summary = 's';
  readonly env = ['TOK'];
  readonly options = {} as const;
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    _parsed: Record<string, unknown>,
    ctx: CommandContext
  ): Promise<void> {
    ctx.io.write('ran');
  }
}

describe('callTool', () => {
  it('returns the command io output as text', async () => {
    const result = await callTool(
      new Echo(),
      {msg: 'hi'},
      {env: {}, log: nullLog()}
    );
    assert.equal(result.isError, undefined);
    const [first] = result.content;
    assert.ok(first);
    assert.equal(first.text, 'echo hi');
  });

  it('returns isError when a required option is missing', async () => {
    const result = await callTool(new Echo(), {}, {env: {}, log: nullLog()});
    assert.equal(result.isError, true);
    const [first] = result.content;
    assert.ok(first);
    assert.match(first.text, /msg/);
  });

  it('returns isError when a declared env var is missing', async () => {
    const result = await callTool(
      new NeedsEnv(),
      {},
      {env: {}, log: nullLog()}
    );
    assert.equal(result.isError, true);
    const [first] = result.content;
    assert.ok(first);
    assert.match(first.text, /TOK/);
  });
});
