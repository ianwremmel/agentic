import {createHash} from 'node:crypto';

import type {BlockingAnalysis} from './blocking.mts';
import {isResolved} from './roles.mts';
import type {GraphEdge, GraphNode, Milestone, ReviewRecord} from './types.mts';

export interface MilestoneState {
  id: string;
  project: string;
  name: string;
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
 * The member set alone cannot see a member reopened and re-verified *between two
 * syncs*: the graph never observes the milestone as un-ready, the ids are
 * unchanged, and the old review would go on satisfying the gate — which §2.6
 * forbids. The tracker's own `updatedAt` does see it, because reopening the
 * ticket moved it.
 *
 * A member with no `updatedAt` is no evidence of change: an adapter that does not
 * report one would otherwise invalidate every review it records.
 */
function movedSince(
  members: readonly GraphNode[],
  recordedAtMs: number
): boolean {
  return members.some((member) => {
    if (member.updatedAt === null) return false;
    // Compare parsed instants, not strings: two ISO timestamps in different
    // offsets (`…04:00Z` vs `…00:30-05:00`) sort wrong lexically but compare
    // right by time.
    const movedMs = Date.parse(member.updatedAt);
    // An unparseable `updatedAt` is no evidence of movement — same as a missing
    // one — so it does not invalidate the review.
    return !Number.isNaN(movedMs) && movedMs > recordedAtMs;
  });
}

/**
 * Milestone readiness, per §2.3: a milestone is ready for review when every
 * member is `verified` or `canceled` and no member has an unresolved dependency.
 * An empty milestone is never ready — there is nothing to review, and calling it
 * reviewed would let it gate later milestones forever.
 *
 * Readiness is computed from members alone (their roles, and their *task*
 * dependencies via `analysis`), never from milestone sequencing. That is what
 * keeps milestone gating acyclic: a milestone's readiness cannot depend on a
 * later milestone being reviewed.
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

    const membersSettled = members.length > 0 && openCount === 0;
    const dependenciesResolved = members.every(
      (member) =>
        (analysis.unresolvedAncestors.get(member.id) ?? []).length === 0
    );

    states.set(milestone.id, {
      id: milestone.id,
      project: milestone.project,
      name: milestone.name,
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

/** A milestone gates work once it is reviewed: both ready and review-recorded. */
export function isMilestoneReviewed(
  state: MilestoneState | undefined
): boolean {
  return state !== undefined && state.readyForReview && state.reviewRecorded;
}

/**
 * Every milestone that transitively blocks each milestone, walked over the
 * milestone-to-milestone edges. This is what replaces the old `sortOrder` index:
 * sequencing is a DAG, so a milestone can have several predecessors.
 *
 * Cycle-safe (a milestone on a cycle simply includes itself) and iterative, so a
 * deep chain cannot blow the stack.
 */
export function milestoneAncestry(
  milestones: readonly Milestone[],
  milestoneEdges: readonly GraphEdge[]
): Map<string, Set<string>> {
  const ids = new Set(milestones.map((milestone) => milestone.id));
  const blockersOf = new Map<string, string[]>();
  for (const edge of milestoneEdges) {
    if (!ids.has(edge.blocked)) continue;
    const bucket = blockersOf.get(edge.blocked);
    if (bucket === undefined) blockersOf.set(edge.blocked, [edge.blocker]);
    else if (!bucket.includes(edge.blocker)) bucket.push(edge.blocker);
  }

  const ancestry = new Map<string, Set<string>>();
  for (const milestone of milestones) {
    const seen = new Set<string>();
    const stack = [...(blockersOf.get(milestone.id) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      stack.push(...(blockersOf.get(id) ?? []));
    }
    ancestry.set(milestone.id, seen);
  }

  return ancestry;
}

/**
 * The §2.6 milestone-review gate: a task cannot start while a milestone that
 * blocks its own milestone is not yet reviewed. Sequencing comes from the
 * milestone edges (via `ancestry`), membership from the task's `milestone` field.
 *
 * Returns the ids of the gating milestones, empty if none.
 */
export function gatingMilestones(
  node: GraphNode,
  states: ReadonlyMap<string, MilestoneState>,
  ancestry: ReadonlyMap<string, Set<string>>
): string[] {
  if (node.milestone === null) return [];

  return [...(ancestry.get(node.milestone) ?? [])]
    .filter((id) => {
      const candidate = states.get(id);
      return (
        candidate !== undefined &&
        candidate.memberCount > 0 &&
        !isMilestoneReviewed(candidate)
      );
    })
    .sort();
}

/**
 * Whether the milestone's current episode has been reviewed: a record covering
 * exactly this member set, taken after the last time any member moved.
 */
function isRecorded(
  review: ReviewRecord | undefined,
  fingerprint: string,
  members: readonly GraphNode[]
): boolean {
  if (review?.fingerprint !== fingerprint) return false;
  const recordedAtMs = Date.parse(review.recordedAt);
  // A record with an unparseable timestamp cannot be shown to precede a member's
  // last move, so it cannot satisfy the gate — the milestone needs a fresh review.
  if (Number.isNaN(recordedAtMs)) return false;
  return !movedSince(members, recordedAtMs);
}
