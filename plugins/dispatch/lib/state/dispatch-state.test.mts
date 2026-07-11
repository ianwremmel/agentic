/**
 * Tests for `dispatch-state`, driven as a real subprocess.
 *
 * This is what bounds how much work runs on the host and decides which agents are
 * still alive, so its failure modes are silent and expensive: a ledger that does
 * not bound, a lock that reads as stale while its owner is building, an active
 * set that loses an entry. Each test proves one of those cannot happen — including
 * under genuine concurrency, which is the case the previous file-based
 * implementation could not survive.
 */

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'bin', 'dispatch-state');

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the command in `runDir`. Never throws — the exit code is the point. */
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

test('the ledger bounds concurrency: the third builder is told to wait', () => {
  const dir = runDir();
  assert.equal(state(dir, ['slot', 'acquire', 'work-ticket:DEV-1']).stdout, 'slot-1');
  assert.equal(state(dir, ['slot', 'acquire', 'deliver:o/r#7']).stdout, 'slot-2');

  const third = state(dir, ['slot', 'acquire', 'deliver:o/r#8']);
  assert.equal(third.status, 1, 'a full ledger must fail, so the caller waits instead of building');
  assert.match(third.stderr, /ledger full/);

  state(dir, ['slot', 'release', 'work-ticket:DEV-1']);
  assert.equal(state(dir, ['slot', 'free']).stdout, '1');
  assert.equal(state(dir, ['slot', 'acquire', 'deliver:o/r#8']).stdout, 'slot-1', 'freed capacity is reused');
});

test('the bound holds when every agent races for the last entry at once', () => {
  const dir = runDir();
  const script = join(HERE, '..', '..', '..', '..', 'plugins', 'dispatch', 'bin', 'dispatch-state');

  // Six processes, each trying to take four entries from a ledger of two.
  const racers = Array.from({length: 6}, (_, p) =>
    execFileSync(
      process.execPath,
      [
        '-e',
        `const {execFileSync} = require('node:child_process');
         let won = 0;
         for (let i = 0; i < 4; i++) {
           try { execFileSync(${JSON.stringify(script)}, ['slot', 'acquire', 'racer-${p}-' + i], {stdio: 'ignore'}); won++; } catch {}
         }
         process.stdout.write(String(won));`,
      ],
      {encoding: 'utf8', env: {...process.env, DISPATCH_RUN_DIR: dir, DISPATCH_MAX_PARALLEL: '2'}},
    ),
  );

  const won = racers.reduce((sum, out) => sum + Number(out), 0);
  assert.equal(won, 2, 'exactly two of the twenty-four attempts may win — the ledger is the bound');
  assert.equal(state(dir, ['slot', 'free']).stdout, '0');
});

test('concurrent writers do not lose each other updates to the active set', () => {
  const dir = runDir();
  const script = join(HERE, '..', '..', 'bin', 'dispatch-state');

  Array.from({length: 6}, (_, p) =>
    execFileSync(
      process.execPath,
      [
        '-e',
        `const {execFileSync} = require('node:child_process');
         for (let i = 0; i < 10; i++)
           execFileSync(${JSON.stringify(script)}, ['unit', 'put', 'DEV-${p}-' + i, 'dispatched'], {stdio: 'ignore'});`,
      ],
      {encoding: 'utf8', env: {...process.env, DISPATCH_RUN_DIR: dir}},
    ),
  );

  assert.equal(
    state(dir, ['unit', 'keys']).stdout.split('\n').length,
    60,
    'a read-modify-write on a JSON file would drop entries here; a transaction does not',
  );
});

test('an agent cannot release or heartbeat an entry it does not hold', () => {
  const dir = runDir();
  state(dir, ['slot', 'acquire', 'mine']);
  assert.equal(state(dir, ['slot', 'release', 'someone-else']).status, 1);
  assert.equal(state(dir, ['slot', 'heartbeat', 'someone-else']).status, 1);
  assert.equal(state(dir, ['slot', 'free']).stdout, '1', 'my entry is untouched');
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

  assert.match(state(dir, ['slot', 'reap'], stale).stdout, /reclaimed slot-1 \(stale owner=crashed\)/);
  assert.match(state(dir, ['lock', 'sweep'], stale).stdout, /cleared stale lock DEV-1/);
  assert.equal(
    state(dir, ['lock', 'live', 'DEV-1'], stale).status,
    1,
    'a crashed coordinator must not hold its ticket forever',
  );
  assert.equal(state(dir, ['slot', 'free'], stale).stdout, '2', 'its capacity comes back');
});

test('a heartbeat keeps a long build alive past the staleness threshold', () => {
  const dir = runDir();
  const stale = {DISPATCH_STALE_SECS: '2'};
  state(dir, ['slot', 'acquire', 'builder'], stale);
  state(dir, ['lock', 'acquire', 'DEV-1', 'agent-1', 'ticket'], stale);

  execFileSync('sleep', ['1']);
  state(dir, ['slot', 'heartbeat', 'builder'], stale);
  state(dir, ['lock', 'heartbeat', 'DEV-1'], stale);
  execFileSync('sleep', ['1']);

  assert.equal(state(dir, ['slot', 'reap'], stale).stdout, '', 'a heartbeating builder is alive');
  assert.equal(state(dir, ['lock', 'live', 'DEV-1'], stale).status, 0);
});

test('two coordinators cannot hold the same ticket', () => {
  const dir = runDir();
  assert.equal(state(dir, ['lock', 'acquire', 'DEV-1', 'agent-1', 'ticket']).status, 0);
  const second = state(dir, ['lock', 'acquire', 'DEV-1', 'agent-2', 'ticket']);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /locked by agent-1/);
});

test('keys that differ only in punctuation are different units', () => {
  const dir = runDir();
  assert.equal(state(dir, ['lock', 'acquire', 'owner/name#17', 'a1', 'pr']).status, 0);
  assert.equal(
    state(dir, ['lock', 'acquire', 'owner_name_17', 'a2', 'ticket']).status,
    0,
    'sanitizing both to one path would make two unrelated units block each other',
  );
  assert.notEqual(
    state(dir, ['unit', 'dir', 'owner/name#17']).stdout,
    state(dir, ['unit', 'dir', 'owner_name_17']).stdout,
  );
});

test('injected ids survive a tick that had no capacity to dispatch them', () => {
  const dir = runDir();
  state(dir, ['inject', 'add', 'DEV-42']);
  state(dir, ['inject', 'add', 'DEV-42']);
  assert.equal(state(dir, ['inject', 'list']).stdout, 'DEV-42', 'injecting twice records it once');

  state(dir, ['inject', 'drop', 'DEV-42']);
  assert.equal(state(dir, ['inject', 'list']).stdout, '');
  assert.equal(state(dir, ['unit', 'keys']).stdout, '', 'dropping an unworked injection leaves nothing behind');
});

test('a ticket already in flight keeps its state when it is injected', () => {
  const dir = runDir();
  state(dir, ['unit', 'put', 'DEV-7', 'dispatched']);
  state(dir, ['inject', 'add', 'DEV-7']);
  state(dir, ['inject', 'drop', 'DEV-7']);

  const units = JSON.parse(state(dir, ['unit', 'list']).stdout) as Array<{key: string; state: string}>;
  assert.deepEqual(units, [{key: 'DEV-7', state: 'dispatched', detail: null}], 'un-injecting must not drop live work');
});

test('queued work is handed to exactly one tick', () => {
  const dir = runDir();
  state(dir, ['inject', 'queue', '{"kind":"ticket","id":"DEV-9"}']);
  state(dir, ['inject', 'queue', '{"kind":"pr","repo":"o/r","pr_number":17}']);

  const drained = JSON.parse(state(dir, ['inbox', 'drain']).stdout) as unknown[];
  assert.deepEqual(drained, [
    {kind: 'ticket', id: 'DEV-9'},
    {kind: 'pr', repo: 'o/r', pr_number: 17},
  ]);
  assert.deepEqual(JSON.parse(state(dir, ['inbox', 'drain']).stdout), [], 'a drained item is not redelivered');
});

test('malformed injected work is refused at the door, not at drain time', () => {
  const dir = runDir();
  assert.notEqual(state(dir, ['inject', 'queue', 'not-json']).status, 0);
  assert.deepEqual(JSON.parse(state(dir, ['inbox', 'drain']).stdout), [], 'one bad item cannot wedge the queue');
});

test('draining an empty queue is a normal, quiet tick', () => {
  const dir = runDir();
  assert.deepEqual(JSON.parse(state(dir, ['inbox', 'drain']).stdout), []);
});

test('an outcome is read back from the path the command hands out', () => {
  const dir = runDir();
  const unitDir = state(dir, ['unit', 'dir', 'DEV-1']).stdout;
  writeFileSync(join(unitDir, 'outcome.xml'), '<outcome key="DEV-1" result="verified"/>');
  assert.match(state(dir, ['unit', 'outcome', 'DEV-1']).stdout, /result="verified"/);

  state(dir, ['lock', 'acquire', 'DEV-1', 'agent-1', 'ticket']);
  state(dir, ['unit', 'cleanup', 'DEV-1']);
  assert.equal(state(dir, ['unit', 'outcome', 'DEV-1']).status, 1, 'cleanup drops the unit');
  assert.equal(state(dir, ['lock', 'live', 'DEV-1']).status, 1, 'and its lock');
});

test('a re-dispatched unit cannot read its predecessor outcome', () => {
  const dir = runDir();
  writeFileSync(join(state(dir, ['unit', 'dir', 'DEV-1']).stdout, 'outcome.xml'), '<outcome result="failed"/>');
  state(dir, ['unit', 'cleanup', 'DEV-1']);

  // SQLite reuses the rowid, so a stale artifact left on disk would come back as
  // this dispatch's outcome and be reconciled as if the new coordinator had failed.
  state(dir, ['unit', 'put', 'DEV-1', 'dispatched']);
  assert.equal(state(dir, ['unit', 'outcome', 'DEV-1']).status, 1, 'the new dispatch has no outcome yet');
});

test('a run directory survives being reopened: this is what a stateless tick relies on', () => {
  const dir = runDir();
  state(dir, ['unit', 'put', 'DEV-1', 'dispatched']);
  state(dir, ['lock', 'acquire', 'DEV-1', 'agent-1', 'ticket']);
  state(dir, ['slot', 'acquire', 'builder']);

  // A new process — the next tick — sees exactly what the last one left.
  assert.equal(state(dir, ['unit', 'keys']).stdout, 'DEV-1');
  assert.equal(state(dir, ['lock', 'live', 'DEV-1']).status, 0);
  assert.equal(state(dir, ['slot', 'free']).stdout, '1');
  assert.ok(readFileSync(join(dir, 'state.db')).length > 0);
});

test('a non-integer ledger size is refused before anything is dispatched', () => {
  const dir = runDir();
  const bad = state(dir, ['slot', 'free'], {DISPATCH_MAX_PARALLEL: '2.5'});
  assert.equal(bad.status, 5);
  assert.match(bad.stderr, /must be a positive integer/);
});

test('a missing run directory is a configuration error, not a full ledger', () => {
  try {
    execFileSync(BIN, ['slot', 'acquire', 'x'], {
      encoding: 'utf8',
      env: {...process.env, DISPATCH_RUN_DIR: ''},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('expected a failure');
  } catch (error) {
    const e = error as {status: number; stderr: string};
    assert.equal(e.status, 5, 'exit 1 would tell the caller to wait for capacity that will never come');
    assert.match(e.stderr, /DISPATCH_RUN_DIR required/);
  }
});

test('an injected ticket stays on the frontier until it is actually dispatched', () => {
  const dir = runDir();
  state(dir, ['inject', 'add', 'DEV-42']);
  assert.equal(
    state(dir, ['unit', 'list']).stdout.includes('injected'),
    true,
    'the injection is recorded so it survives a tick with no capacity',
  );

  state(dir, ['unit', 'put', 'DEV-42', 'dispatched']);
  assert.equal(state(dir, ['inject', 'list']).stdout, 'DEV-42', 'it keeps its rank while it runs');
});
