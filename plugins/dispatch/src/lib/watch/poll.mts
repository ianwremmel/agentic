import {nowIso} from '../db/time.mts';
import {withDatabase} from '../db/index.mts';
import type {Logger} from '../logger/index.mts';
import {WatchStore} from '../stores/index.mts';
import {cadenceFor, EXPIRY_SECONDS} from './cadence.mts';
import {diffSnapshots} from './diff.mts';
import type {Snapshotter} from './snapshot.mts';

/** Snapshot calls one pass will make; keeps a tick short. */
const MAX_POLLS_PER_PASS = 10;

/**
 * One polling pass over the due watches: fire the expired ones outright,
 * snapshot the rest, and record what changed as events.
 *
 * A watch fires only when the diff produced something — an unchanged PR, or
 * one that changed in a way only the agent itself caused, leaves the row
 * watching. That is the whole point of diffing structurally rather than
 * hashing: a worker is woken for a reason it can be told.
 *
 * A parked item never reads as expired (`due`), so for it the diff is the
 * only thing that fires: it is waiting on a person, and "your six hours are
 * up" is not an answer.
 *
 * A failed snapshot costs only that row's interval: `touch` pushes the retry
 * out so a broken PR is not hammered every tick, and the error goes to the
 * log rather than failing the pass.
 */
export async function pollWatches(
  env: NodeJS.ProcessEnv,
  opts: {
    snapshot: Snapshotter;
    dbPath?: string | undefined;
    now?: () => string;
    log?: Logger | undefined;
  }
): Promise<{fired: string[]}> {
  const now = opts.now ?? nowIso;
  return withDatabase(opts.dbPath, env, async (db) => {
    const watches = new WatchStore(db);
    // Every unconcluded PR item is watched — including one parked on an
    // operator — whether or not a worker ever asked. A PR moves whether
    // anyone is waiting on it, and an item nobody armed is exactly the one
    // whose change would otherwise be missed.
    await watches.ensureForLiveItems(now(), EXPIRY_SECONDS);
    const fired: string[] = [];

    for (const due of await watches.due(now(), MAX_POLLS_PER_PASS)) {
      if (due.expired) {
        if ((await watches.fire(due.node, now(), due.createdAt)) === 'fired') {
          fired.push(due.node);
        }
        continue;
      }
      try {
        const taken = await opts.snapshot(due.repo, due.prNumber);
        const observed = diffSnapshots(due.snapshot, taken);
        // Changed or not changed is the only question. There is no predicate
        // for "has the thing you were waiting for happened", because a worker
        // cannot say what it is waiting for and any such predicate tests a
        // persistent state — which fires again the moment the worker returns.
        //
        // One transaction: recording events and firing the watch must not be
        // separable, or a crash between them re-emits the same events on the
        // next tick against the same unchanged snapshot.
        const outcome = await watches.observe({
          node: due.node,
          snapshot: taken,
          at: now(),
          createdAt: due.createdAt,
          fire: observed.length > 0,
          intervalSeconds: cadenceFor(taken),
          expiresAt: new Date(
            Date.parse(now()) + EXPIRY_SECONDS * 1_000
          ).toISOString(),
          events: observed,
        });
        if (outcome === 'fired') fired.push(due.node);
      } catch (error) {
        await watches.touch(due.node, now(), due.createdAt);
        opts.log?.error('watch poll failed', {
          node: due.node,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {fired};
  });
}
