import {nowIso} from '../db/time.mts';
import {withDatabase} from '../db/index.mts';
import type {Logger} from '../logger/index.mts';
import type {WatchReason} from '../model/status.mts';
import {WatchStore} from '../stores/index.mts';
import {reviewedByOthers, satisfied} from './condition.mts';
import {diffSnapshots} from './diff.mts';
import type {Snapshotter} from './snapshot.mts';

/** Poll cadence per wait kind, from the channel server's interval table. */
export const INTERVAL_SECONDS: Readonly<Record<WatchReason, number>> = {
  ci: 60,
  review: 300,
  merge: 300,
};

/**
 * How long a watch runs before firing regardless. The snapshot sees only the
 * forge, so an approval on the ticket or a reaction never reaches it; expiry
 * is the safety net that sends the worker to look for itself.
 */
export const EXPIRY_SECONDS: Readonly<Record<WatchReason, number>> = {
  ci: 3_600,
  review: 21_600,
  merge: 21_600,
};

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
        // Two independent reasons to wake the worker: something changed that
        // it would act on, or the thing it is waiting for already holds. The
        // second is what covers a change that landed before the baseline was
        // taken, which no diff can see.
        const done = satisfied(due.reason, taken, {
          reviewedByOthers: reviewedByOthers(taken),
        });
        // One transaction: recording events and firing the watch must not be
        // separable, or a crash between them re-emits the same events on the
        // next tick against the same unchanged snapshot.
        const outcome = await watches.observe({
          node: due.node,
          snapshot: taken,
          at: now(),
          createdAt: due.createdAt,
          fire: observed.length > 0 || done,
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
