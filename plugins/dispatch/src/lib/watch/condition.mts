import type {WatchReason} from '../model/status.mts';
import type {PrSnapshot} from './snapshot.mts';

/**
 * Whether the wait is over judged from one snapshot, rather than from a change
 * between two.
 *
 * This exists because arming takes a baseline: anything that landed between
 * the worker's last read and the handoff is folded into it and never appears
 * as a change. A condition evaluated absolutely catches that.
 *
 * The catch is that most "conditions" are persistent states, and firing on a
 * persistent state loops. A worker that addresses a `CHANGES_REQUESTED`
 * review and re-arms would wake immediately — `reviewDecision` still reads
 * `CHANGES_REQUESTED` until the reviewer looks again — find nothing new, and
 * re-arm. Each turn of that loop claims the item and spends an admission, so
 * it is a compute leak, not merely noise.
 *
 * So only genuinely self-clearing conditions belong here:
 *
 * - terminal states, which end the run rather than returning to a wait;
 * - a settled check rollup, which resets to pending on the next push.
 *
 * `review` and `merge` have none. Their waits end through the diff, and the
 * residual gap — a verdict that landed in the seconds between the worker's
 * last read and its handoff — is covered by the watch expiry rather than by a
 * predicate that would spin. Trading a bounded delay for an unbounded loop is
 * not a trade worth making.
 */
export function satisfied(reason: WatchReason, snapshot: PrSnapshot): boolean {
  // Terminal for every reason: there is no wait left to return to.
  if (snapshot.merged || snapshot.state === 'CLOSED') return true;
  // A conflict blocks whatever the worker was waiting for, and clears only
  // when the worker rebases — so it cannot fire twice for one cause.
  if (snapshot.mergeState === 'DIRTY') return true;

  if (reason === 'ci') {
    // Every check reported. A PR with no checks is not waiting on CI, so it
    // is satisfied rather than hanging until expiry.
    return (
      snapshot.checks.length === 0 ||
      snapshot.checks.every((check) => check.conclusion !== null)
    );
  }
  return false;
}
