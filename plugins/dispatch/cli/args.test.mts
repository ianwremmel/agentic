import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {splitArgv} from './args.mts';

await describe('splitArgv', async () => {
  await it('splits globals, command, and command args at the command name', () => {
    assert.deepEqual(
      splitArgv(['--log-level', 'debug', 'greet', '--name', 'Ada']),
      {
        globalArgs: ['--log-level', 'debug'],
        command: 'greet',
        commandArgs: ['--name', 'Ada'],
      }
    );
  });

  await it('does not mistake a global option value for the command', () => {
    // `debug` is the value of --log-level, not a command name.
    assert.equal(splitArgv(['--log-level', 'debug', 'greet']).command, 'greet');
  });

  await it('leaves command flags unparsed, even ones the CLI also defines', () => {
    assert.deepEqual(splitArgv(['greet', '--help', '--', '-x']), {
      globalArgs: [],
      command: 'greet',
      commandArgs: ['--help', '--', '-x'],
    });
  });

  await it('reports no command when only globals are given', () => {
    assert.deepEqual(splitArgv(['--help']), {
      globalArgs: ['--help'],
      command: undefined,
      commandArgs: [],
    });
  });

  await it('reports no command for empty argv', () => {
    assert.deepEqual(splitArgv([]), {
      globalArgs: [],
      command: undefined,
      commandArgs: [],
    });
  });

  await it('keeps an unknown global flag in globalArgs for the strict parse to reject', () => {
    assert.deepEqual(splitArgv(['--nope', 'greet']), {
      globalArgs: ['--nope'],
      command: 'greet',
      commandArgs: [],
    });
  });
});
