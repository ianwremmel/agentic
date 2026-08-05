import type {PrSnapshot} from './snapshot.mts';

/**
 * Event kinds, four of them the channel-server event catalog's PR/CI triggers.
 *
 * `pr_conflicted` and `pr_head_changed` are additions: the catalog has no
 * event for "the base moved and this no longer merges" or "someone else
 * pushed to the branch", and a worker waiting on merge must react to both.
 * Adding kinds is allowed; renaming the catalog's four would be breaking.
 */
export const OBSERVATION_KINDS = [
  'ci_finished',
  'pr_review',
  'pr_comment',
  'pr_state_change',
  'pr_conflicted',
  'pr_head_changed',
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export interface Observation {
  readonly kind: ObservationKind;
  /**
   * Per-kind channel meta, beyond the `repo`/`pr` the pusher adds. Values are
   * stringified at push time; the runner drops a non-string.
   */
  readonly meta: Readonly<Record<string, string>>;
  /** One line for a human reading the log. The pushed body is `pr-status`. */
  readonly summary: string;
}

/**
 * Check conclusions that mean "this check is OK". Anything terminal and not
 * in this set counts as a failure, so a conclusion GitHub adds later reads as
 * failing rather than silently passing.
 */
const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function failing(snapshot: PrSnapshot): string[] {
  return snapshot.checks
    .filter(
      (check) => check.conclusion !== null && !PASSING.has(check.conclusion)
    )
    .map((check) => check.name);
}

function settled(snapshot: PrSnapshot): boolean {
  return (
    snapshot.checks.length > 0 &&
    snapshot.checks.every((check) => check.conclusion !== null)
  );
}

/** The forge's word for "this no longer merges cleanly". */
const CONFLICTED = 'DIRTY';

/**
 * What changed between two observations of one PR.
 *
 * Authorship is judged by this agent's machine marker, never by the account:
 * under shared credentials the agent posts as the operator, so filtering by
 * login would suppress the operator's own review — the one signal a waiting
 * worker most needs. The marker says "this agent wrote it" whatever account
 * carried it. Waking a worker to report its own comment is the noise that
 * would make server-side waiting worse than the polling it replaces.
 *
 * A null `previous` is the first observation after arming, and yields
 * nothing. The wait's own condition is evaluated separately by the caller,
 * which is what catches a change that landed before the baseline was taken.
 */
export function diffSnapshots(
  previous: PrSnapshot | null,
  next: PrSnapshot
): Observation[] {
  if (previous === null) return [];
  const events: Observation[] = [];

  if (next.merged && !previous.merged) {
    return [
      {
        kind: 'pr_state_change',
        meta: {state: 'merged'},
        summary: 'The PR merged.',
      },
    ];
  }

  if (next.state === 'CLOSED' && previous.state !== 'CLOSED') {
    // Whether a closed-unmerged PR actually shipped is `pr-status`'s call — a
    // squash or rebase can land the content without setting `merged`. The
    // event says the lifecycle moved; the body tells the worker which way.
    return [
      {
        kind: 'pr_state_change',
        meta: {state: 'closed'},
        summary: 'The PR closed.',
      },
    ];
  }

  if (next.draft !== previous.draft) {
    events.push({
      kind: 'pr_state_change',
      meta: {state: next.draft ? 'draft' : 'ready'},
      summary: next.draft
        ? 'The PR went back to draft.'
        : 'The PR left draft and is ready for review.',
    });
  }

  if (next.head !== previous.head && next.head !== null) {
    events.push({
      kind: 'pr_head_changed',
      meta: {head: next.head},
      summary: `The head commit moved to ${next.head.slice(0, 8)}.`,
    });
  }

  // CI is reported per rollup, not per check: `ci_finished` fires when the
  // rollup reaches a terminal state. Naming the failures in meta is the
  // detail the rollup verdict alone cannot carry. Comparing the failing set
  // (not just settled-ness) is what catches a rerun that goes straight from
  // failing to green between two polls.
  const nowFailing = failing(next);
  const rollupChanged =
    settled(next) &&
    (!settled(previous) ||
      failing(previous).join(',') !== nowFailing.join(',') ||
      previous.head !== next.head);
  if (rollupChanged) {
    events.push({
      kind: 'ci_finished',
      meta: {
        rollup: nowFailing.length > 0 ? 'failure' : 'success',
        ...(nowFailing.length > 0 ? {failing: nowFailing.join(',')} : {}),
      },
      summary:
        nowFailing.length > 0
          ? `CI finished with failures: ${nowFailing.join(', ')}.`
          : 'CI finished green.',
    });
  }

  // A review is identified by (author, state, submittedAt): a reviewer walks
  // pending -> verdict, and a re-request pushes them back to pending, so the
  // author alone cannot tell a new verdict from an old one.
  const seenReviews = new Set(
    previous.reviews.map(
      (review) => `${review.author} ${review.state} ${review.submittedAt ?? ''}`
    )
  );
  for (const review of next.reviews) {
    const key = `${review.author} ${review.state} ${review.submittedAt ?? ''}`;
    if (seenReviews.has(key)) continue;
    if (review.state === 'PENDING' || review.mine) continue;
    events.push({
      kind: 'pr_review',
      meta: {state: reviewState(review.state), reviewer: review.author},
      summary: `${review.author} left a ${reviewState(review.state)} review.`,
    });
  }

  const before = new Map(previous.threads.map((thread) => [thread.id, thread]));
  for (const thread of next.threads) {
    const prior = before.get(thread.id);
    const moved =
      prior?.lastAt !== thread.lastAt || prior.resolved !== thread.resolved;
    if (!moved || thread.resolved || thread.mine) continue;
    events.push({
      kind: 'pr_comment',
      meta: {thread: thread.id},
      summary:
        prior === undefined
          ? `${thread.lastAuthor ?? 'someone'} opened a review thread.`
          : `${thread.lastAuthor ?? 'someone'} replied on a review thread.`,
    });
  }

  // An id absent from the previous window is only new when that window held
  // every comment. Past the cap the older entries fall out, and treating
  // their reappearance as new would fire on comments from last week.
  const windowComplete = previous.totals.comments <= previous.comments.length;
  const known = new Set(previous.comments.map((comment) => comment.id));
  for (const comment of next.comments) {
    if (known.has(comment.id) || comment.mine) continue;
    if (!windowComplete && comment.createdAt <= newestOf(previous.comments)) {
      continue;
    }
    events.push({
      kind: 'pr_comment',
      meta: {thread: comment.id},
      summary: `${comment.author} commented on the PR.`,
    });
  }

  if (next.mergeState === CONFLICTED && previous.mergeState !== CONFLICTED) {
    events.push({
      kind: 'pr_conflicted',
      meta: {mergeState: next.mergeState},
      summary: 'The PR now conflicts with its base branch.',
    });
  }

  return coalesce(events);
}

function newestOf(comments: PrSnapshot['comments']): string {
  return comments.reduce(
    (newest, comment) =>
      comment.createdAt > newest ? comment.createdAt : newest,
    ''
  );
}

function reviewState(state: string): string {
  if (state === 'APPROVED') return 'approved';
  if (state === 'CHANGES_REQUESTED') return 'changes';
  return 'comment';
}

/**
 * One event per kind per tick, as the channel's ordering rule requires: meta
 * is single-valued, so two comments on one tick cannot both be described by
 * one event's `thread`. The first is kept and a `more` count records what it
 * stands for; the worker reads the full `pr-status` body either way, so
 * nothing it needs to act on is lost.
 */
function coalesce(events: readonly Observation[]): Observation[] {
  const byKind = new Map<ObservationKind, Observation>();
  const extra = new Map<ObservationKind, number>();
  for (const event of events) {
    if (!byKind.has(event.kind)) {
      byKind.set(event.kind, event);
      continue;
    }
    extra.set(event.kind, (extra.get(event.kind) ?? 0) + 1);
  }
  return [...byKind.values()].map((event) => {
    const more = extra.get(event.kind);
    return more === undefined
      ? event
      : {
          ...event,
          meta: {...event.meta, more: String(more)},
          summary: `${event.summary} (+${String(more)} more)`,
        };
  });
}
