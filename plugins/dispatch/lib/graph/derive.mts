/**
 * All the graph reasoning, in one place.
 *
 * The orchestrator is forbidden from re-deriving any of this: effective
 * blocking, the milestone-review gate, ranking, cycles, and completion all land
 * here so that every consumer sees one answer.
 */

import {findCycles} from './cycles.mts';
import {
  DEFAULT_PRIORITY,
  PARKED,
  TERMINAL,
  type Anomaly,
  type CachedNode,
  type Counts,
  type DerivedMilestone,
  type DerivedNode,
  type Document,
  type Graph,
  type Milestone,
} from './types.mts';

export interface DeriveOptions {
  /** Ids in flight, done, or failed. They only leave `available`; nothing else. */
  exclude?: string[];
  /** Injected ids, ranked ahead of everything else. */
  priority?: string[];
}

const isTerminal = (n: CachedNode): boolean => TERMINAL.has(n.role);
const isParked = (n: CachedNode): boolean => PARKED.has(n.role);
const isDead = (n: CachedNode): boolean => Boolean(n.dead);

/**
 * Waiting on a human: the explicit tracker signal, a human-only work item, or a
 * coordinator's worker-discovered park. `paused` is *not* a human handoff — it
 * means stopped for other priorities, and alerting a human about it would be
 * noise.
 */
const isHumanBlocked = (n: CachedNode): boolean =>
  !isTerminal(n) &&
  (Boolean(n.human_interactive) || n.target_kind === 'human-only' || n.role === 'awaiting-external');

/**
 * Memoize a set-valued graph walk.
 *
 * The seeded empty set is a cycle guard: a walk that re-enters itself sees an
 * empty result rather than recursing forever. The walk also stops at any node in
 * a cycle, so `unlocks` under-counts work sitting behind one — acceptable,
 * because a cycle is already an anomaly and its members are never dispatched.
 */
function memoize(fn: (id: string, recur: (id: string) => Set<string>) => Set<string>) {
  const cache = new Map<string, Set<string>>();
  const recur = (id: string): Set<string> => {
    const hit = cache.get(id);
    if (hit) return hit;
    cache.set(id, new Set());
    const value = fn(id, recur);
    cache.set(id, value);
    return value;
  };
  return recur;
}

/**
 * Turn the cache into the document the orchestrator reads.
 *
 * @param graph the durable cache
 * @param options exclusions (scheduling only) and injected priorities
 */
export function derive(graph: Graph, options: DeriveOptions = {}): Document {
  // A node in the cache is a real ticket. One without a role would silently
  // schedule as `backlog` (never dispatched) or terminal (completing the run).
  for (const n of graph.nodes) {
    if (!n.role) throw new Error(`node ${n.id} has no role`);
  }
  const cached = graph.nodes as CachedNode[];
  const nodes = new Map(cached.map((n) => [n.id, n]));
  const blockers = new Map<string, string[]>([...nodes.keys()].map((id) => [id, []]));
  const dependents = new Map<string, string[]>([...nodes.keys()].map((id) => [id, []]));
  const unknownBlockers = new Map<string, string[]>();

  for (const e of graph.edges) {
    if (!nodes.has(e.blocked)) continue; // the dependent is gone; nothing to schedule
    if (!nodes.has(e.blocker)) {
      unknownBlockers.set(e.blocked, [...(unknownBlockers.get(e.blocked) ?? []), e.blocker]);
      continue;
    }
    blockers.get(e.blocked)!.push(e.blocker);
    dependents.get(e.blocker)!.push(e.blocked);
  }

  const cycles = findCycles(nodes.keys(), dependents);
  const inCycle = new Set(cycles.flat());

  const ancestorsOf = memoize((id, recur) => {
    const seen = new Set<string>();
    for (const b of blockers.get(id) ?? []) {
      if (seen.has(b)) continue;
      seen.add(b);
      if (!inCycle.has(b)) for (const a of recur(b)) seen.add(a);
    }
    return seen;
  });

  const descendantsOf = memoize((id, recur) => {
    const seen = new Set<string>();
    for (const d of dependents.get(id) ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (!inCycle.has(d)) for (const x of recur(d)) seen.add(x);
    }
    return seen;
  });

  const anomalies: Anomaly[] = [
    ...cycles.map((c): Anomaly => ({kind: 'cycle', nodes: c})),
    ...[...unknownBlockers].map(([node, missing]): Anomaly => ({
      kind: 'unknown-blocker',
      node,
      blockers: missing,
    })),
  ];

  /**
   * Ready for review: every ticket in the milestone is terminal, and so is every
   * ancestor of one. A member with a blocker outside the synced set is not known
   * to be unblocked, so it holds the milestone back rather than opening the gate
   * on top of an anomaly.
   */
  const milestones = graph.milestones.map((m) => {
    const members = cached.filter((n) => n.milestone === m.id);
    const ready =
      members.length > 0 &&
      members.every(
        (n) =>
          isTerminal(n) &&
          !unknownBlockers.has(n.id) &&
          [...ancestorsOf(n.id)].every((a) => isTerminal(nodes.get(a)!) && !unknownBlockers.has(a)),
      );
    return {
      ...m,
      project: m.project ?? '',
      order: m.order ?? 0,
      members: members.map((n) => n.id),
      ready_for_review: ready,
    };
  });
  const milestoneById = new Map(milestones.map((m) => [m.id, m]));

  /**
   * The milestone-review gate, expressed as blocking so the orchestrator needs no
   * milestone state machine: a ticket is blocked while any *earlier* milestone of
   * its project is not both ready-for-review and review-recorded.
   *
   * An empty milestone gates nothing — it has no review to run, and gating on one
   * would deadlock every milestone behind it.
   */
  const gateOf = (n: CachedNode): string | null => {
    const own = milestoneById.get(n.milestone ?? '');
    if (!own) return null;
    const open = milestones
      .filter(
        (m) =>
          m.project === own.project &&
          m.order < own.order &&
          m.members.length > 0 &&
          !(m.ready_for_review && m.review_recorded),
      )
      .sort((a, b) => a.order - b.order);
    return open[0]?.id ?? null;
  };

  for (const n of cached) {
    if (n.milestone && !milestoneById.has(n.milestone))
      anomalies.push({kind: 'unknown-milestone', node: n.id, milestone: n.milestone});
  }

  const tagged: DerivedNode[] = cached.map((n) => {
    const ancestors = [...ancestorsOf(n.id)].map((a) => nodes.get(a)!);
    const gate = gateOf(n);
    return {
      ...n,
      blocked_by: blockers.get(n.id) ?? [],
      effective_blocked:
        ancestors.some((a) => !isTerminal(a)) || Boolean(gate) || unknownBlockers.has(n.id),
      milestone_gate: gate,
      permanently_blocked: isDead(n) || ancestors.some(isDead),
      human_blocked: isHumanBlocked(n),
      unlocks: descendantsOf(n.id).size,
    };
  });

  const excluded = new Set(options.exclude ?? []);
  const available = tagged
    .filter(
      (n) =>
        !isTerminal(n) &&
        !n.permanently_blocked &&
        !n.human_blocked &&
        !n.effective_blocked &&
        !isParked(n) &&
        !inCycle.has(n.id) &&
        n.group !== 'backlog' &&
        !excluded.has(n.id),
    )
    .sort(rankBy(options.priority ?? [], milestoneById))
    .map((n) => n.id);

  const workable = (n: DerivedNode): boolean => !isTerminal(n) && !n.permanently_blocked;
  const blocked = tagged.filter((n) => workable(n) && n.effective_blocked && !n.human_blocked);
  const human = tagged.filter((n) => workable(n) && n.human_blocked);
  // Work in flight is excluded from the frontier but is emphatically not stalled:
  // reporting a ticket a coordinator is building as "nothing will dispatch this"
  // is how an operator loses track of a run.
  const scheduled = new Set([
    ...available,
    ...blocked.map((n) => n.id),
    ...human.map((n) => n.id),
    ...excluded,
  ]);

  const tally = (members: DerivedNode[]): Counts => ({
    total: members.length,
    verified: members.filter((n) => n.role === 'verified').length,
    canceled: members.filter((n) => n.role === 'canceled').length,
    permanently_blocked: members.filter((n) => n.permanently_blocked).length,
    remaining: members.filter(workable).length,
    // An empty set is NOT terminal. A failed fetch that returns no nodes would
    // otherwise read as "every project is complete" and stop the run.
    terminal: members.length > 0 && members.every((n) => !workable(n)),
  });

  const derivedMilestones: DerivedMilestone[] = milestones.map((m) => ({
    id: m.id,
    project: m.project,
    name: m.name,
    order: m.order,
    ready_for_review: m.ready_for_review,
    review_recorded: Boolean(m.review_recorded),
    counts: tally(tagged.filter((n) => n.milestone === m.id)),
  }));

  return {
    cursor: graph.cursor ?? null,
    projects: graph.projects.map((p) => ({
      ...p,
      counts: tally(tagged.filter((n) => n.project === p.id)),
    })),
    milestones: derivedMilestones,
    nodes: tagged,
    available,
    blocked: blocked.map((n) => n.id),
    human_blocked: human.map((n) => n.id),
    permanently_blocked: tagged.filter((n) => n.permanently_blocked).map((n) => n.id),
    stalled: tagged.filter((n) => workable(n) && !scheduled.has(n.id)).map((n) => n.id),
    counts: tally(tagged),
    anomalies: [
      ...anomalies,
      ...crossProjectCycles(graph, nodes).map((projects): Anomaly => ({
        kind: 'cross-project-cycle',
        projects,
      })),
    ],
  };
}

/**
 * Rank the frontier: injected work first, then priority, then the earliest
 * milestone, then whatever unblocks the most, then id. The last key makes the
 * order total, so two ticks over an unchanged graph dispatch the same ticket.
 */
function rankBy(priority: string[], milestoneById: Map<string, Milestone>) {
  const top = new Set(priority);
  const pri = (n: CachedNode): number =>
    top.has(n.id) ? -Infinity : (n.priority ?? DEFAULT_PRIORITY);
  const ord = (n: CachedNode): number =>
    milestoneById.get(n.milestone ?? '')?.order ?? Number.MAX_SAFE_INTEGER;

  return (a: DerivedNode, b: DerivedNode): number =>
    pri(a) - pri(b) ||
    ord(a) - ord(b) ||
    b.unlocks - a.unlocks ||
    String(a.id).localeCompare(String(b.id));
}

/**
 * Projects that transitively depend on each other cannot be scheduled in any
 * order. Report them; never work around them.
 */
function crossProjectCycles(graph: Graph, nodes: Map<string, CachedNode>): string[][] {
  const next = new Map<string, string[]>(graph.projects.map((p) => [p.id, []]));
  for (const e of graph.edges) {
    const from = nodes.get(e.blocker)?.project;
    const to = nodes.get(e.blocked)?.project;
    if (!from || !to || from === to) continue;
    const edges = next.get(from);
    if (edges && !edges.includes(to)) edges.push(to);
  }
  return findCycles(next.keys(), next);
}
