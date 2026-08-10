import type {PrSnapshot} from './snapshot.mts';

/**
 * How long to wait before reading a PR again, derived from where the PR
 * actually is rather than from a reason the worker declared.
 *
 * A worker cannot reliably say what it is waiting for — it may be waiting for
 * several things at once, and whatever it declared goes stale the moment the
 * PR moves. The PR's own state is the better signal and the server already
 * has it, which is also what makes the interval data-driven rather than a
 * constant table.
 */
export const CADENCE_SECONDS = {
  /** Checks are running: the next transition is close. */
  ciActive: 60,
  /** Checks have reported and someone must look: a person's timescale. */
  awaitingReview: 300,
  /** Nothing is pending; watch only for an out-of-band change. */
  idle: 900,
} as const;

export function cadenceFor(snapshot: PrSnapshot | null): number {
  if (snapshot === null) return CADENCE_SECONDS.ciActive;
  if (snapshot.checks.some((check) => check.conclusion === null)) {
    return CADENCE_SECONDS.ciActive;
  }
  // Out of draft with the forge still asking for review, or a reviewer who
  // has not returned a verdict.
  const awaiting =
    !snapshot.draft &&
    (snapshot.reviewDecision === 'REVIEW_REQUIRED' ||
      snapshot.reviews.some((review) => review.state === 'PENDING'));
  return awaiting ? CADENCE_SECONDS.awaitingReview : CADENCE_SECONDS.idle;
}

/**
 * How long a watch runs before firing regardless of the diff. The snapshot
 * sees only the forge, so an approval given on the ticket or a reaction never
 * reaches it; expiry sends the worker to look for itself.
 *
 * Measured from when the wait was armed, never from the last poll — a
 * deadline a poll can push out is one a quiet PR never reaches, and a quiet
 * PR is the only kind that needs it. The cost of it working is that every
 * unchanged PR wakes a worker once per window, which is the intended price:
 * a wasted look every six hours against an item stranded indefinitely.
 */
export const EXPIRY_SECONDS = 21_600;
