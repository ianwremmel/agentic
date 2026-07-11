/**
 * `dispatch-state` — the run's state, from the command line.
 *
 * Every agent in a run shares this: coordinators and delivery workers take
 * compute slots, dispatched units hold locks and write outcomes, and the
 * orchestrator reads the active set.
 *
 * Exit codes are load-bearing:
 *   0  the operation succeeded
 *   1  refused — the ledger is full, or the lock is held, or the caller does not
 *      hold what it asked to release. Callers wait and retry; they never proceed.
 *   2  the command line was wrong
 *   5  the run's configuration is not usable
 */

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import * as state from './db.mts';

const DEFAULT_MAX_PARALLEL = 3;
const DEFAULT_STALE_SECS = 900;

class Refused extends Error {}

/** Read a positive integer from the environment, or fail loudly. */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`dispatch-state: ${name} must be a positive integer, got "${raw}"`);
    process.exit(5);
  }
  return value;
}

function usage(): never {
  console.error(
    'usage: dispatch-state {init|slot|lock|unit|inject|inbox} <command> [args]\n' +
      '  slot   acquire|release|heartbeat <owner> | free | reap\n' +
      '  lock   acquire <key> <agent> <kind> | heartbeat|release|live <key> | sweep | list\n' +
      '  unit   put <key> <state> [detail] | drop|dir|outcome|cleanup <key> | keys | list\n' +
      '  inject add <key> | drop <key> | list | queue <json>\n' +
      '  inbox  drain',
  );
  process.exit(2);
}

export function main(argv: string[]): void {
  const runDir = process.env.DISPATCH_RUN_DIR;
  if (!runDir) {
    console.error('dispatch-state: DISPATCH_RUN_DIR required: the run directory the orchestrator exports');
    process.exit(5);
  }

  const maxParallel = positiveInt('DISPATCH_MAX_PARALLEL', DEFAULT_MAX_PARALLEL);
  const staleSecs = positiveInt('DISPATCH_STALE_SECS', DEFAULT_STALE_SECS);

  const [group, command, ...args] = argv;
  const arg = (i: number): string => {
    const value = args[i];
    if (value === undefined) usage();
    return value;
  };

  const db = state.open(runDir);

  try {
    switch (`${group}:${command ?? ''}`) {
      case 'init:':
      case 'init:init': {
        console.log(runDir);
        return;
      }

      case 'slot:acquire': {
        const id = state.acquireSlot(db, arg(0), maxParallel);
        if (id === null) throw new Refused(`ledger full (${maxParallel} held)`);
        console.log(`slot-${id}`);
        return;
      }
      case 'slot:release': {
        if (!state.releaseSlot(db, arg(0))) throw new Refused(`no entry held by ${arg(0)}`);
        return;
      }
      case 'slot:heartbeat': {
        if (!state.heartbeatSlot(db, arg(0))) throw new Refused(`no entry held by ${arg(0)}`);
        return;
      }
      case 'slot:free': {
        console.log(state.freeSlots(db, maxParallel));
        return;
      }
      case 'slot:reap': {
        for (const slot of state.reapSlots(db, staleSecs))
          console.log(`reclaimed slot-${slot.id} (stale owner=${slot.owner})`);
        return;
      }

      case 'lock:acquire': {
        const result = state.acquireLock(db, arg(0), arg(1), arg(2));
        if (!result.ok) throw new Refused(`${arg(0)} is locked by ${result.heldBy}`);
        return;
      }
      case 'lock:heartbeat': {
        if (!state.heartbeatLock(db, arg(0))) throw new Refused(`no lock for ${arg(0)}`);
        return;
      }
      case 'lock:release': {
        state.releaseLock(db, arg(0));
        return;
      }
      case 'lock:live': {
        if (!state.lockLive(db, arg(0), staleSecs)) process.exit(1);
        return;
      }
      case 'lock:sweep': {
        for (const lock of state.sweepLocks(db, staleSecs))
          console.log(`cleared stale lock ${lock.key} (agent=${lock.agent_id})`);
        return;
      }
      case 'lock:list': {
        console.log(JSON.stringify(state.listLocks(db), null, 2));
        return;
      }

      case 'unit:put': {
        state.putUnit(db, arg(0), arg(1), args[2]);
        return;
      }
      case 'unit:drop': {
        state.dropUnit(db, arg(0));
        return;
      }
      case 'unit:keys': {
        for (const key of state.unitKeys(db)) console.log(key);
        return;
      }
      case 'unit:list': {
        console.log(JSON.stringify(state.listUnits(db), null, 2));
        return;
      }
      case 'unit:dir': {
        console.log(state.unitDir(db, runDir, arg(0)));
        return;
      }
      case 'unit:outcome': {
        const path = join(state.unitDir(db, runDir, arg(0)), 'outcome.xml');
        if (!existsSync(path)) process.exit(1);
        process.stdout.write(readFileSync(path, 'utf8'));
        return;
      }
      case 'unit:cleanup': {
        state.cleanupUnit(db, runDir, arg(0));
        return;
      }

      case 'inject:add': {
        state.inject(db, arg(0));
        return;
      }
      case 'inject:drop': {
        state.uninject(db, arg(0));
        return;
      }
      case 'inject:list': {
        for (const key of state.injectedKeys(db)) console.log(key);
        return;
      }
      case 'inject:queue': {
        state.queueInjection(db, arg(0));
        return;
      }

      case 'inbox:drain': {
        console.log(JSON.stringify(state.drainInjections(db), null, 2));
        return;
      }

      default:
        usage();
    }
  } catch (error) {
    if (error instanceof Refused) {
      console.error(`dispatch-state: ${error.message}`);
      process.exit(1);
    }
    throw error;
  } finally {
    db.close();
  }
}
