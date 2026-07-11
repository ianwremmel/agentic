/**
 * Tests for `bin/dispatch-state`, driven as a real subprocess.
 *
 * This script bounds how much work runs on the host and decides which agents are
 * still alive, so its failure modes are silent and expensive: a ledger that does
 * not bound, a lock that reads as stale while its owner is building, an active
 * set clobbered to empty. Each test proves one of those cannot happen.
 */

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'dispatch-state');

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the script in `runDir`. Never throws — the exit code is the point. */
function state(runDir: string, args: string[], env: Record<string, string> = {}): Run {
  try {
    const stdout = execFileSync(BIN, args, {
      encoding: 'utf8',
      env: {...process.env, DISPATCH_RUN_DIR: runDir, DISPATCH_MAX_PARALLEL: '2', ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {status: 0, stdout: stdout.trim(), stderr: ''};
  } catch (error) {
    const e = error as {status: number; stdout?: string; stderr?: string};
    return {status: e.status, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim()};
  }
}

const runDir = (): string => mkdtempSync(join(tmpdir(), 'dispatch-state-'));

test('the ledger bounds concurrency: the third builder waits', () => {
  const dir = runDir();
  assert.equal(state(dir, ['slot', 'acquire', 'work-ticket:DEV-1']).stdout, 'slot-1');
  assert.equal(state(dir, ['slot', 'acquire', 'deliver:o/r#7']).stdout, 'slot-2');

  const third = state(dir, ['slot', 'acquire', 'deliver:o/r#8']);
  assert.equal(third.status, 1, 'a full ledger must fail, so the caller waits instead of building');
  assert.match(third.stderr, /ledger full/);

  state(dir, ['slot', 'release', 'work-ticket:DEV-1']);
  assert.equal(state(dir, ['slot', 'free']).stdout, '1');
  assert.equal(state(dir, ['slot', 'acquire', 'deliver:o/r#8']).stdout, 'slot-1');
});

test('an agent cannot release or heartbeat an entry it does not hold', () => {
  const dir = runDir();
  state(dir, ['slot', 'acquire', 'mine']);
  assert.equal(state(dir, ['slot', 'release', 'someone-else']).status, 1);
  assert.equal(state(dir, ['slot', 'heartbeat', 'someone-else']).status, 1);
  assert.equal(state(dir, ['slot', 'free']).stdout, '1', 'my entry is still held');
});

test('a live claim is never reaped, however long the run has been up', () => {
  const dir = runDir();
  state(dir, ['slot', 'acquire', 'builder']);
  state(dir, ['lock', 'acquire', 'DEV-1', 'agent-1', 'ticket']);

  assert.equal(state(dir, ['slot', 'reap']).stdout, '', 'a fresh entry is not stale');
  assert.equal(state(dir, ['lock', 'sweep']).stdout, '');
  assert.equal(state(dir, ['lock', 'live', 'DEV-1']).status, 0);
  assert.equal(state(dir, ['slot', 'free']).stdout, '1');
});

test('a dead agent is reclaimed once its heartbeat goes stale', () => {
  const dir = runDir();
  const stale = {DISPATCH_STALE_SECS: '1'};
  state(dir, ['slot', 'acquire', 'crashed'], stale);
  state(dir, ['lock', 'acquire', 'DEV-1', 'agent-1', 'ticket'], stale);

  execFileSync('sleep', ['2']);

  assert.match(state(dir, ['slot', 'reap'], stale).stdout, /reclaimed slot-1/);
  assert.match(state(dir, ['lock', 'sweep'], stale).stdout, /cleared stale lock DEV-1/);
  assert.equal(
    state(dir, ['lock', 'live', 'DEV-1'], stale).status,
    1,
    'a crashed coordinator must not hold its ticket forever',
  );
  assert.equal(state(dir, ['slot', 'free'], stale).stdout, '2', 'its capacity comes back');
});

test('a claim that has been made but not yet stamped is not reaped out from under its owner', () => {
  const dir = runDir();
  state(dir, ['init']);
  // The window inside `slot acquire`: the directory exists, `beat` does not yet.
  mkdirSync(join(dir, 'ledger', 'slot-1'));
  assert.equal(state(dir, ['slot', 'reap']).stdout, '', 'reaping it would let two agents hold one slot');
  assert.equal(state(dir, ['slot', 'free']).stdout, '1');
});

test('two coordinators cannot hold the same ticket', () => {
  const dir = runDir();
  assert.equal(state(dir, ['lock', 'acquire', 'DEV-1', 'agent-1', 'ticket']).status, 0);
  const second = state(dir, ['lock', 'acquire', 'DEV-1', 'agent-2', 'ticket']);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /locked by agent-1/);
});

test('keys that differ only in punctuation get different locks', () => {
  const dir = runDir();
  assert.equal(state(dir, ['lock', 'acquire', 'owner/name#17', 'a1', 'pr']).status, 0);
  assert.equal(
    state(dir, ['lock', 'acquire', 'owner_name_17', 'a2', 'ticket']).status,
    0,
    'collapsing punctuation would make these two units block each other',
  );
  assert.notEqual(state(dir, ['unit', 'dir', 'owner/name#17']).stdout, state(dir, ['unit', 'dir', 'owner_name_17']).stdout);
});

test('a malformed payload cannot destroy the active set', () => {
  const dir = runDir();
  state(dir, ['init']);
  state(dir, ['active', 'put', 'DEV-1', '{"state":"dispatched"}']);

  assert.notEqual(state(dir, ['active', 'put', 'DEV-2', 'not-json']).status, 0);

  const active = JSON.parse(readFileSync(join(dir, 'active.json'), 'utf8')) as {units: Record<string, unknown>};
  assert.deepEqual(
    Object.keys(active.units),
    ['DEV-1'],
    'clobbering this to empty would read downstream as "nothing in flight"',
  );
});

test('injected ids survive a tick that could not dispatch them', () => {
  const dir = runDir();
  state(dir, ['init']);
  state(dir, ['active', 'inject', 'DEV-42']);
  state(dir, ['active', 'inject', 'DEV-42']);
  assert.equal(state(dir, ['active', 'injected']).stdout, 'DEV-42', 'injecting twice records it once');

  state(dir, ['active', 'uninject', 'DEV-42']);
  assert.equal(state(dir, ['active', 'injected']).stdout, '');
});

test('draining an empty inbox is a normal, quiet tick', () => {
  const dir = runDir();
  assert.equal(state(dir, ['inbox', 'drain']).stdout, '[]');
  assert.equal(state(dir, ['inbox', 'drain']).status, 0);
});

test('one malformed inbox file cannot hold the others hostage', () => {
  const dir = runDir();
  state(dir, ['init']);
  writeFileSync(join(dir, 'inbox', 'good.json'), '{"kind":"ticket","id":"DEV-9"}');
  writeFileSync(join(dir, 'inbox', 'bad.json'), 'not json');

  const drained = state(dir, ['inbox', 'drain']);
  assert.equal(drained.status, 0);
  assert.deepEqual(JSON.parse(drained.stdout), [{kind: 'ticket', id: 'DEV-9'}]);
  assert.deepEqual(JSON.parse(state(dir, ['inbox', 'drain']).stdout), [], 'a drained item is not redelivered');
});

test('an outcome is read back from the path the script hands out', () => {
  const dir = runDir();
  state(dir, ['init']);
  const unitDir = state(dir, ['unit', 'dir', 'DEV-1']).stdout;
  mkdirSync(unitDir, {recursive: true});
  writeFileSync(join(unitDir, 'outcome.xml'), '<outcome key="DEV-1" result="verified"/>');

  assert.match(state(dir, ['unit', 'outcome', 'DEV-1']).stdout, /result="verified"/);

  state(dir, ['lock', 'acquire', 'DEV-1', 'agent-1', 'ticket']);
  state(dir, ['unit', 'cleanup', 'DEV-1']);
  assert.equal(state(dir, ['unit', 'outcome', 'DEV-1']).status, 1, 'cleanup removes the artifact');
  assert.equal(state(dir, ['lock', 'live', 'DEV-1']).status, 1, 'and the lock');
});

test('a non-integer ledger size is refused before it reaches shell arithmetic', () => {
  const dir = runDir();
  const bad = state(dir, ['slot', 'free'], {DISPATCH_MAX_PARALLEL: '2.5'});
  assert.equal(bad.status, 5);
  assert.match(bad.stderr, /must be a positive integer/);
});
