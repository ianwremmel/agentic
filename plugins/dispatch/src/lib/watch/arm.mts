import type {Database} from '../db/database.mts';
import {WatchStore} from '../stores/index.mts';
import type {WatchReason} from '../model/status.mts';
import type {Logger} from '../logger/index.mts';
import {EXPIRY_SECONDS, INTERVAL_SECONDS} from './poll.mts';
import type {Fingerprint} from './poll.mts';

/**
 * Arm a watch with the PR's fingerprint as of right now, so a change that
 * lands between the worker's last look and the first server poll still
 * fires. A failed baseline degrades to priming on the first successful poll
 * — a narrow re-opening of that gap, taken over failing the handoff.
 */
export async function armWatch(
  db: Database,
  input: {
    node: string;
    reason: WatchReason;
    repo: string;
    prNumber: number;
    at: string;
    fingerprint: Fingerprint;
    log?: Logger | undefined;
  }
): Promise<void> {
  let baseline: string | null = null;
  try {
    baseline = await input.fingerprint(input.repo, input.prNumber);
  } catch (error) {
    input.log?.warn('watch armed without a baseline fingerprint', {
      node: input.node,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await new WatchStore(db).set({
    node: input.node,
    reason: input.reason,
    intervalSeconds: INTERVAL_SECONDS[input.reason],
    at: input.at,
    expiresAt: new Date(
      Date.parse(input.at) + EXPIRY_SECONDS[input.reason] * 1_000
    ).toISOString(),
    fingerprint: baseline,
  });
}
