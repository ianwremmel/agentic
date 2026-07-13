import type { BlockingAnalysis } from './blocking.mts';
import type { GraphNode } from './types.mts';

/**
 * Ranking of the available frontier, most urgent first. The key is total and
 * deterministic, so two runs over the same graph always produce the same order:
 *
 * 1. Injected work first — runtime injection ranks to the top of the frontier
 *    (it still never preempts work already in flight; that is the
 *    orchestrator's call, not the ranking's).
 * 2. Higher priority first. `priority` is normalized by the adapter so that
 *    lower means more urgent; absent priority sorts last.
 * 3. More downstream work unblocked first — the transitive descendant count.
 *    This is what keeps the critical path moving instead of finishing leaves.
 * 4. Ticket id, so the order is stable when everything else ties.
 *
 * Milestone order is deliberately absent. Milestone sequencing is enforced by
 * the gate, not by the ranking: a ticket in a later milestone is *blocked*
 * until the earlier one is reviewed, so it cannot reach this frontier early no
 * matter how it sorts. Ranking on it as well would add nothing within a project
 * and would compare project-local sort orders across projects, where they carry
 * no shared meaning.
 */
export function rankAvailable(
  candidates: readonly GraphNode[],
  analysis: BlockingAnalysis,
): GraphNode[] {
  return [...candidates].sort((a, b) => {
    if (a.injected !== b.injected) return a.injected ? -1 : 1;

    const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
    const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
    if (priorityA !== priorityB) return priorityA - priorityB;

    const fanoutA = analysis.descendantCount.get(a.id) ?? 0;
    const fanoutB = analysis.descendantCount.get(b.id) ?? 0;
    if (fanoutA !== fanoutB) return fanoutB - fanoutA;

    return a.id.localeCompare(b.id);
  });
}
