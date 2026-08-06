import type {Database} from '../db/database.mts';
import {WatchStore} from '../stores/index.mts';
import type {Logger} from '../logger/index.mts';
import {cadenceFor, EXPIRY_SECONDS} from './cadence.mts';
import type {PrSnapshot, Snapshotter} from './snapshot.mts';

/**
 * Hand an item back to the server: record the PR as it stands now and release
 * the worker's claim, in one transaction.
 *
 * The baseline is what the next poll diffs against. A failed read degrades to
 * priming on the first successful poll, which widens the window in which a
 * change goes unreported — taken over failing the handoff.
 */
export async function armWatch(
  db: Database,
  input: {
    node: string;
    repo: string;
    prNumber: number;
    at: string;
    snapshot: Snapshotter;
    session: string | null;
    releaseClaimFor?: string | null;
    log?: Logger | undefined;
  }
): Promise<void> {
  let baseline: PrSnapshot | null = null;
  try {
    baseline = await input.snapshot(input.repo, input.prNumber);
  } catch (error) {
    input.log?.warn('watch armed without a baseline snapshot', {
      node: input.node,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await new WatchStore(db).set({
    node: input.node,
    intervalSeconds: cadenceFor(baseline),
    at: input.at,
    expiresAt: new Date(
      Date.parse(input.at) + EXPIRY_SECONDS * 1_000
    ).toISOString(),
    snapshot: baseline,
    session: input.session,
    releaseClaimFor: input.releaseClaimFor ?? null,
  });
}
