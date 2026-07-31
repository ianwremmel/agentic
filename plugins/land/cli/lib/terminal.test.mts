import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {Runner, RunResult} from './exec.mts';
import type {PrJson} from './github.mts';
import {terminalXml} from './terminal.mts';

const ok = (stdout = ''): RunResult => ({code: 0, stdout, stderr: ''});
const fail = (code = 1): RunResult => ({code, stdout: '', stderr: ''});

/** A runner that never expects to be called (open/merged paths need no shell). */
const unusedRunner: Runner = (cmd, args) => {
  throw new Error(`unexpected process: ${cmd} ${args.join(' ')}`);
};

/**
 * Emulate gh compare + the git content-check sequence. `aheadBy` is what the
 * compare returns; `apply` decides whether the reverse-apply succeeds (present)
 * or not (absent); `inRepo=false` makes the whole git check unavailable.
 */
function forgeRunner(opts: {
  aheadBy: string;
  apply?: 'present' | 'absent';
  inRepo?: boolean;
}): Runner {
  return (cmd, args) => {
    if (cmd === 'gh') return Promise.resolve(ok(opts.aheadBy));
    if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
    const sub = args[0];
    if (sub === 'rev-parse' && args[1] === '--git-dir') {
      return Promise.resolve(opts.inRepo === false ? fail(128) : ok('.git'));
    }
    if (sub === 'fetch') return Promise.resolve(ok());
    if (sub === 'rev-parse') return Promise.resolve(ok('deadbeef'));
    if (sub === 'merge-base') return Promise.resolve(ok('c0ffee'));
    if (sub === 'diff' && args.includes('--quiet'))
      return Promise.resolve(fail(1));
    if (sub === 'read-tree') return Promise.resolve(ok());
    if (sub === 'diff') return Promise.resolve(ok('PATCH'));
    if (sub === 'apply') {
      return Promise.resolve(opts.apply === 'present' ? ok() : fail(1));
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

const base: PrJson = {
  number: 7,
  baseRefName: 'main',
  headRefOid: 'abc123',
};

describe('terminalXml', () => {
  it('reports draft for an open draft PR without shelling out', async () => {
    const xml = await terminalXml({
      run: unusedRunner,
      pr: {...base, state: 'OPEN', isDraft: true},
      owner: 'o',
      repo: 'r',
    });
    assert.match(xml, /state="draft" gh-merged="false" ahead-by="-"/u);
  });

  it('reports shipped from the merged flag alone', async () => {
    const xml = await terminalXml({
      run: unusedRunner,
      pr: {...base, state: 'MERGED'},
      owner: 'o',
      repo: 'r',
    });
    assert.match(xml, /state="shipped" gh-merged="true"/u);
  });

  it('reports shipped when compare shows ahead_by 0 (no git)', async () => {
    const xml = await terminalXml({
      run: forgeRunner({aheadBy: '0'}),
      pr: {...base, state: 'CLOSED'},
      owner: 'o',
      repo: 'r',
    });
    assert.match(xml, /state="shipped" gh-merged="false" ahead-by="0"/u);
  });

  it('reports shipped when the content check finds the change in base', async () => {
    const xml = await terminalXml({
      run: forgeRunner({aheadBy: '3', apply: 'present'}),
      pr: {...base, state: 'CLOSED'},
      owner: 'o',
      repo: 'r',
    });
    assert.match(xml, /state="shipped" gh-merged="false" ahead-by="3"/u);
  });

  it('reports abandoned when the change is not present in base', async () => {
    const xml = await terminalXml({
      run: forgeRunner({aheadBy: '3', apply: 'absent'}),
      pr: {...base, state: 'CLOSED'},
      owner: 'o',
      repo: 'r',
    });
    assert.match(xml, /state="abandoned" gh-merged="false" ahead-by="3"\/>/u);
  });

  it('never claims delivery when the content check cannot run', async () => {
    const xml = await terminalXml({
      run: forgeRunner({aheadBy: '3', inRepo: false}),
      pr: {...base, state: 'CLOSED'},
      owner: 'o',
      repo: 'r',
    });
    assert.match(
      xml,
      /state="abandoned"[^/]*error="content-check-unavailable"/u
    );
  });
});
