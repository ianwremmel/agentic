import {attr} from './xml.mts';

interface ReviewAuthor {
  readonly login?: string;
  readonly __typename?: string;
}

export interface ReviewNode {
  readonly author?: ReviewAuthor | null;
  readonly state?: string;
}

interface RequestedReviewer {
  readonly __typename?: string;
  readonly login?: string;
  readonly slug?: string;
  readonly name?: string;
}

export interface ReviewRequestNode {
  readonly requestedReviewer?: RequestedReviewer | null;
}

/** The two GraphQL connections, rewrapped into one input. */
export interface ReviewsInput {
  readonly reviews: {readonly nodes?: readonly ReviewNode[]};
  readonly reviewRequests: {readonly nodes?: readonly ReviewRequestNode[]};
}

interface ReviewerRecord {
  login: string;
  isBot: boolean;
  state: string;
}

const VALID_STATES = new Set([
  'pending',
  'commented',
  'approved',
  'changes_requested',
  'dismissed',
]);

/** Logins GitHub does not type as a Bot but that the protocol treats as one. */
const BOT_LOGIN_RE = /copilot|codex|claude|ai-agent/u;

/**
 * One persistent record per reviewer: a reviewer who was requested OR has
 * reviewed appears exactly once, carrying a status that walks
 * pending → commented/changes_requested/approved (plus dismissed).
 *
 * An outstanding request OVERRIDES any prior verdict back to `pending` — a fresh
 * request replaces the old review until the reviewer re-reviews — so a
 * re-requested Copilot, or an operator re-requested after approving, reads as
 * pending and the agent keeps polling. An unsubmitted (PENDING) review is an
 * author-only draft, invisible to the protocol, and is dropped: "pending" in the
 * output always comes from an outstanding request, never a draft review.
 */
export function reviewsXml(input: ReviewsInput, operatorLogin: string): string {
  const operatorLc = operatorLogin.toLowerCase();

  const requested = (input.reviewRequests.nodes ?? [])
    .map((node) => node.requestedReviewer)
    .filter((r): r is RequestedReviewer => r !== undefined && r !== null)
    .map((r) => ({
      login: r.login ?? r.slug ?? r.name ?? '',
      isBot: (r.__typename ?? '') === 'Bot',
    }))
    .filter((r) => r.login !== '');

  const requestedSet = new Set(requested.map((r) => r.login.toLowerCase()));

  // Latest submitted review per author (last write wins, position preserved).
  const byLogin = new Map<string, ReviewerRecord>();
  for (const review of input.reviews.nodes ?? []) {
    const login = review.author?.login ?? '';
    if (login === '' || review.state === 'PENDING') continue;
    byLogin.set(login.toLowerCase(), {
      login,
      isBot: (review.author?.__typename ?? '') === 'Bot',
      state: review.state ?? 'COMMENTED',
    });
  }

  // A pending stub for any requested reviewer that has not reviewed.
  for (const req of requested) {
    const key = req.login.toLowerCase();
    if (!byLogin.has(key)) {
      byLogin.set(key, {login: req.login, isBot: req.isBot, state: 'PENDING'});
    }
  }

  const lines = ['  <reviews>'];
  for (const [key, record] of byLogin) {
    const state = requestedSet.has(key) ? 'PENDING' : record.state;
    lines.push(reviewLine(record.login, record.isBot, state, operatorLc));
  }
  lines.push('  </reviews>');
  return lines.join('\n');
}

function reviewLine(
  author: string,
  isBot: boolean,
  rawState: string,
  operatorLc: string
): string {
  const mode =
    isBot || BOT_LOGIN_RE.test(author.toLowerCase()) ? 'bot' : 'human';
  const lowered = rawState.toLowerCase();
  const state = VALID_STATES.has(lowered) ? lowered : 'commented';

  if (mode === 'human') {
    const role = author.toLowerCase() === operatorLc ? 'operator' : 'team';
    return `    <review author="${attr(author)}" mode="human" role="${role}" state="${state}"/>`;
  }
  return `    <review author="${attr(author)}" mode="bot" state="${state}"/>`;
}
