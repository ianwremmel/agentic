import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {misplacedGlobalOptions, splitArgv} from './args.mts';

describe('splitArgv', () => {
  it('leaves a global option written after the command with the command', () => {
    // Globals are positional: everything after the command belongs to it. The
    // command then rejects `--log-level` as unknown, and run.mts turns that into
    // a hint rather than a bare "unknown option".
    assert.deepEqual(splitArgv(['greet', '--log-level', 'debug', 'Ada']), {
      globalArgs: [],
      command: 'greet',
      commandArgs: ['--log-level', 'debug', 'Ada'],
    });
  });

  it('does not treat an option value equal to a command name as the command', () => {
    // `greet` here is the value of --log-level, not the command; the real
    // command is the second one. This is why the split reads token indices.
    assert.equal(splitArgv(['--log-level', 'greet', 'greet']).command, 'greet');
    assert.deepEqual(splitArgv(['--log-level', 'greet', 'greet']).globalArgs, [
      '--log-level',
      'greet',
    ]);
  });

  it('splits globals, command, and command args at the command name', () => {
    assert.deepEqual(
      splitArgv(['--log-level', 'debug', 'greet', '--name', 'Ada']),
      {
        globalArgs: ['--log-level', 'debug'],
        command: 'greet',
        commandArgs: ['--name', 'Ada'],
      }
    );
  });

  it('does not mistake a global option value for the command', () => {
    // `debug` is the value of --log-level, not a command name.
    assert.equal(splitArgv(['--log-level', 'debug', 'greet']).command, 'greet');
  });

  it('leaves command flags unparsed, even ones the CLI also defines', () => {
    assert.deepEqual(splitArgv(['greet', '--help', '--', '-x']), {
      globalArgs: [],
      command: 'greet',
      commandArgs: ['--help', '--', '-x'],
    });
  });

  it('reports no command when only globals are given', () => {
    assert.deepEqual(splitArgv(['--help']), {
      globalArgs: ['--help'],
      command: undefined,
      commandArgs: [],
    });
  });

  it('reports no command for empty argv', () => {
    assert.deepEqual(splitArgv([]), {
      globalArgs: [],
      command: undefined,
      commandArgs: [],
    });
  });

  it('keeps an unknown global flag in globalArgs for the strict parse to reject', () => {
    assert.deepEqual(splitArgv(['--nope', 'greet']), {
      globalArgs: ['--nope'],
      command: 'greet',
      commandArgs: [],
    });
  });
});

describe('misplacedGlobalOptions', () => {
  it('names a global option that landed after the command', () => {
    assert.deepEqual(misplacedGlobalOptions(['--log-level', 'debug', 'Ada']), [
      '--log-level',
    ]);
    assert.deepEqual(misplacedGlobalOptions(['--log-level=debug']), [
      '--log-level',
    ]);
  });

  it('finds nothing when the command args are its own', () => {
    assert.deepEqual(misplacedGlobalOptions(['--name', 'Ada']), []);
  });

  it('ignores anything after --, which is the command literal payload', () => {
    assert.deepEqual(misplacedGlobalOptions(['--', '--log-level']), []);
  });
});
