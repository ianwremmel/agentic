import {createHash} from 'node:crypto';

import type {BlockingAnalysis} from './blocking.mts';
import {isResolved} from './roles.mts';
import type {GraphNode, Milestone, ReviewRecord} from './types.mts';

export interface MilestoneState {
  id: string;
  project: string;
  name: string;
  sortOrder: number;
  members: string[];
  memberCount: number;
  openCount: number;
  readyForReview: boolean;
  reviewRecorded: boolean;
  fingerprint: string;
}

/**
 * A milestone's review episode is identified by the member set it covers. When a
 * review files follow-up tickets into the milestone (§2.3), the member set
 * changes, the fingerprint changes, and the recorded review stops matching — so
 * the milestone is reviewed again once it re-completes, which is what §2.6
 * requires.
 */
export function fingerprintMembers(memberIds: readonly string[]): string {
  return createHash('sha256')
    .update([...memberIds].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Whether a member has moved since the review was recorded.
 *
 * The member set alone cannot see a member that was reopened and re-verified
 * *between two syncs*: the graph never observes the milestone as un-ready, the
 * ids are unchanged, and the old review would go on satisfying the gate — which
 * §2.6 forbids ("a stale review record MUST NOT suppress the re-review"). The
 * tracker's own `updatedAt` does see it, because reopening the ticket moved it.
 *
 * A member with no `updatedAt` is no evidence of change: an adapter that does not
 * report one would otherwise invalidate every review it ever records.
 */
function movedSince(
  members: readonly GraphNode[],
  recordedAt: string
): boolean {
  return members.some(
    (member) => member.updatedAt !== null && member.updatedAt > recordedAt
  );
}

/**
 * Milestone readiness, per §2.3: settled means `verified` or `canceled`, and
 * nothing else.
 *
 * A permanently-blocked ticket is NOT settled. It is still open, so its milestone
 * is not complete and cannot be reviewed — the gate stays shut, deliberately.
 * Cancelling the ticket is what resolves it: once a human decides the work will
 * not be done, `canceled` both settles it and releases everything it blocked. The
 * decision to give up on work is a human's to make and record, not something the
 * producer infers by treating dead work as if it were finished.
 */
export function computeMilestoneStates(
  nodes: readonly GraphNode[],
  milestones: readonly Milestone[],
  reviews: readonly ReviewRecord[],
  analysis: BlockingAnalysis
): Map<string, MilestoneState> {
  const membersOf = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.milestone === null) continue;
    const bucket = membersOf.get(node.milestone);
    if (bucket === undefined) membersOf.set(node.milestone, [node]);
    else bucket.push(node);
  }

  const recordFor = new Map(
    reviews.map((review) => [review.milestone, review])
  );

  const states = new Map<string, MilestoneState>();

  for (const milestone of milestones) {
    const members = membersOf.get(milestone.id) ?? [];
    const memberIds = members.map((member) => member.id);
    const fingerprint = fingerprintMembers(memberIds);

    const openCount = members.filter(
      (member) => !isResolved(member.role)
    ).length;

    // §2.3: ready for review means no remaining blockers — every member is
    // `verified` or `canceled`, and no unresolved ticket is a direct or
    // transitive dependency of a member. An empty milestone is never ready:
    // there is nothing to review, and calling it reviewed would let it gate
    // later milestones forever.
    const membersSettled = members.length > 0 && openCount === 0;
    const dependenciesResolved = members.every(
      (member) =>
        (analysis.unresolvedAncestors.get(member.id) ?? []).length === 0
    );

    states.set(milestone.id, {
      id: milestone.id,
      project: milestone.project,
      name: milestone.name,
      sortOrder: milestone.sortOrder,
      members: memberIds,
      memberCount: members.length,
      openCount,
      readyForReview: membersSettled && dependenciesResolved,
      reviewRecorded: isRecorded(
        recordFor.get(milestone.id),
        fingerprint,
        members
      ),
      fingerprint,
    });
  }

  return states;
}

/**
 * The §2.6 milestone-review gate, expressed as effective blocking rather than a
 * state machine: a ticket cannot start while an earlier milestone in its project
 * is not both ready-for-review and review-recorded.
 *
 * Empty milestones are skipped — they carry no work, so they cannot gate.
 *
 * Returns the ids of the earlier milestones gating this node; empty if none.
 */
export function gatingMilestones(
  node: GraphNode,
  states: ReadonlyMap<string, MilestoneState>
): string[] {
  if (node.milestone === null) return [];

  const own = states.get(node.milestone);
  if (own === undefined) return [];

  return [...states.values()]
    .filter(
      (candidate) =>
        candidate.project === own.project &&
        candidate.sortOrder < own.sortOrder &&
        candidate.memberCount > 0 &&
        !(candidate.readyForReview && candidate.reviewRecorded)
    )
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((candidate) => candidate.id);
}

/**
 * Whether the milestone's current episode has been reviewed: a record that covers
 * exactly this member set, taken after the last time any member moved.
 */
function isRecorded(
  review: ReviewRecord | undefined,
  fingerprint: string,
  members: readonly GraphNode[]
): boolean {
  if (review?.fingerprint !== fingerprint) return false;
  return !movedSince(members, review.recordedAt);
}
