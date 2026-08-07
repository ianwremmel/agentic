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
  // Not a PR observation: written by `ticket set` when a tracker write
  // reveals a status transition. Same queue, same delivery.
  'ticket_changed',
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
    // Strictly older only. Timestamps are not a unique key, so a comment
    // sharing the newest one's second would otherwise be dropped for good —
    // the snapshot advances past it and no later tick can rediscover it.
    if (!windowComplete && comment.createdAt < newestOf(previous.comments)) {
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
 * Everything one tick saw about one PR, as a single event.
 *
 * The alternative — one event per change — interrupts a worker mid-reaction:
 * it is told CI failed, starts fixing, and is then told a reviewer replied,
 * which it must handle as a second turn without the first one's context. The
 * worker already reads one `pr-status` blob per tick and reacts to everything
 * in it at once; the channel should not be worse than that.
 *
 * So the kind is a routing hint — the most significant thing that moved —
 * `changed` lists every kind that fired, and the per-kind specifics ride
 * along in meta. The body carries the state the worker acts on.
 */
const PRIORITY: readonly ObservationKind[] = [
  'pr_state_change',
  'pr_conflicted',
  'ci_finished',
  'pr_review',
  'pr_head_changed',
  'pr_comment',
];

function coalesce(events: readonly Observation[]): Observation[] {
  if (events.length <= 1) return [...events];
  const ranked = [...events].sort(
    (a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind)
  );
  const [lead] = ranked;
  if (lead === undefined) return [];
  const meta: Record<string, string> = {};
  // Least significant first, so the lead event's own keys win a collision.
  for (const event of [...ranked].reverse()) {
    for (const [key, value] of Object.entries(event.meta)) meta[key] = value;
  }
  meta.changed = [...new Set(ranked.map((event) => event.kind))].join(',');
  return [
    {
      kind: lead.kind,
      meta,
      summary: ranked.map((event) => event.summary).join(' '),
    },
  ];
}
