import {nowIso} from '../db/time.mts';
import {withDatabase} from '../db/index.mts';
import type {Logger} from '../logger/index.mts';
import type {WatchReason} from '../model/status.mts';
import {WatchStore} from '../stores/index.mts';

export type Fingerprint = (repo: string, prNumber: number) => Promise<string>;

/** Poll cadence per wait kind, from the channel server's interval table. */
export const INTERVAL_SECONDS: Readonly<Record<WatchReason, number>> = {
  ci: 60,
  review: 300,
  merge: 300,
};

/**
 * Every watch also expires: the fingerprint sees only the forge's structural
 * fields, so a signal outside them — an out-of-band approval, a reaction on
 * the engagement comment, a thread resolved without a reply — would
 * otherwise never wake the worker. An expired watch fires unconditionally;
 * the resumed worker re-reads everything, and re-arms if it is still
 * waiting.
 */
export const EXPIRY_SECONDS: Readonly<Record<WatchReason, number>> = {
  ci: 3_600,
  review: 21_600,
  merge: 21_600,
};

/** Fingerprint calls one pass will make; keeps a tick short. */
const MAX_POLLS_PER_PASS = 10;

/**
 * One polling pass over the due watches: fire the expired ones outright,
 * fingerprint the rest, and record what was seen. A failed fingerprint (gh
 * missing, network, a deleted PR) costs only that row's interval: `touch`
 * pushes the retry out so a broken PR is not hammered every tick, and the
 * error goes to the log instead of failing the pass.
 */
export async function pollWatches(
  env: NodeJS.ProcessEnv,
  opts: {
    fingerprint: Fingerprint;
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
        const print = await opts.fingerprint(due.repo, due.prNumber);
        const seen = await watches.observe(
          due.node,
          print,
          now(),
          due.createdAt
        );
        if (seen === 'fired') fired.push(due.node);
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
