import type {WatchReason} from '../model/status.mts';
import type {PrSnapshot} from './snapshot.mts';

/**
 * Whether the thing the worker is waiting for has already happened, judged
 * from one snapshot rather than from a change between two.
 *
 * A diff alone cannot answer this. Arming takes a baseline, so anything that
 * landed between the worker's last read and the handoff is folded into that
 * baseline and never appears as a change — the worker would sleep until
 * expiry on an approval it just missed. Evaluating the condition absolutely
 * on every poll, including the first, closes that window: the wait ends
 * because its condition holds, not because the condition changed.
 *
 * The cost is that a wait armed on an already-satisfied PR fires immediately.
 * That is correct — there is nothing to wait for — and the worker re-reads
 * canonical state anyway.
 */
export function satisfied(
  reason: WatchReason,
  snapshot: PrSnapshot,
  self: {reviewedByOthers: boolean}
): boolean {
  if (snapshot.merged || snapshot.state === 'CLOSED') return true;
  if (snapshot.mergeState === 'DIRTY') return true;

  switch (reason) {
    case 'ci':
      // Every check reported. A PR with no checks at all is not waiting on
      // CI, so it is satisfied too rather than hanging until expiry.
      return (
        snapshot.checks.length === 0 ||
        snapshot.checks.every((check) => check.conclusion !== null)
      );
    case 'review':
      // A verdict from anyone but this agent, or the forge's own decision.
      return (
        self.reviewedByOthers ||
        snapshot.reviewDecision === 'APPROVED' ||
        snapshot.reviewDecision === 'CHANGES_REQUESTED'
      );
    case 'merge':
      return snapshot.mergeState === 'CLEAN';
  }
}

/** Whether anyone but this agent has left a verdict. */
export function reviewedByOthers(snapshot: PrSnapshot): boolean {
  return snapshot.reviews.some(
    (review) => !review.mine && review.state !== 'PENDING'
  );
}
