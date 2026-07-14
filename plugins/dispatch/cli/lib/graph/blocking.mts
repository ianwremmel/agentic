import {isResolved} from './roles.mts';
import type {GraphEdge, GraphNode} from './types.mts';

export interface BlockingAnalysis {
  /** Every transitive ancestor of a node — its blockers, and their blockers. */
  ancestors: Map<string, Set<string>>;
  /** The ancestors that are not `verified`/`canceled`: the ones that block. */
  unresolvedAncestors: Map<string, string[]>;
  /** Transitive descendants: how much work resolving this node would unblock. */
  descendantCount: Map<string, number>;
  /** Each dependency cycle, as the ids on it. Illegal per §2.3, so reported. */
  cycles: string[][];
  /** Edges naming a node the graph has never seen — the fetch was incomplete. */
  danglingEdges: GraphEdge[];
}

/**
 * Effective blocking, cycles, and descendant counts, in one pass over the graph.
 *
 * A node is effectively blocked when any node in its ancestor closure is
 * unresolved. **The walk stops at a resolved ancestor**: a `verified` or
 * `canceled` ticket does not block, and the tickets behind it are no longer on a
 * live path to its dependents.
 *
 * That pruning is the rule, not an optimization. Cancellation *releases*
 * downstream work — §2.6 is explicit that a dependent of a canceled ticket
 * becomes available. Walking past the canceled ancestor into its own open
 * blockers would hold the dependent behind work that was abandoned, which is the
 * outcome the protocol forbids. The same holds for `verified`: the tracker says
 * the ticket is done, and that judgment beats whatever sits behind it.
 *
 * A node on a cycle is its own ancestor, so unless it is resolved it comes out
 * blocked by this rule with no special case.
 */
export function analyzeBlocking(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): BlockingAnalysis {
  const roleOf = new Map(nodes.map((node) => [node.id, node.role]));

  const blockersOf = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  const danglingEdges: GraphEdge[] = [];

  for (const edge of edges) {
    const blockerKnown = roleOf.has(edge.blocker);
    const blockedKnown = roleOf.has(edge.blocked);

    if (!blockerKnown || !blockedKnown) {
      danglingEdges.push(edge);
    }
    // Nothing in the graph depends on this edge, so there is nowhere to hang it.
    if (!blockedKnown) continue;

    // An unfetched blocker still becomes an ancestor: it has no role, so it
    // reads as unresolved and holds its dependent back, rather than the graph
    // offering up work whose blocker nobody has ever seen.
    pushInto(blockersOf, edge.blocked, edge.blocker);
    if (blockerKnown) pushInto(blockedBy, edge.blocker, edge.blocked);
  }

  // A resolved ticket ends the chain: it does not block, and nothing behind it
  // blocks through it.
  const traversable = (id: string): boolean => {
    const role = roleOf.get(id);
    return role === undefined || !isResolved(role);
  };

  const ancestors = new Map<string, Set<string>>();
  const unresolvedAncestors = new Map<string, string[]>();
  const descendantCount = new Map<string, number>();

  for (const node of nodes) {
    const closure = reachable(node.id, blockersOf, traversable);
    ancestors.set(node.id, closure);

    // An unfetched ancestor has no role, which counts as unresolved: never
    // dispatch work whose blocker we cannot see.
    unresolvedAncestors.set(node.id, [...closure].filter(traversable).sort());

    // Descendants are counted over the whole graph, resolved or not: this
    // measures how much work a ticket gates, which is a ranking signal rather
    // than a blocking one.
    descendantCount.set(node.id, reachable(node.id, blockedBy).size);
  }

  return {
    ancestors,
    unresolvedAncestors,
    descendantCount,
    cycles: findCycles(nodes, blockersOf),
    danglingEdges,
  };
}

export function isEffectivelyBlocked(
  analysis: BlockingAnalysis,
  id: string
): boolean {
  return (analysis.unresolvedAncestors.get(id) ?? []).length > 0;
}

function pushInto(
  map: Map<string, string[]>,
  key: string,
  value: string
): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else if (!existing.includes(value)) {
    existing.push(value);
  }
}

/**
 * Every node reachable from `start` along `next`, excluding `start` itself
 * unless a cycle leads back to it. Iterative, so a deep chain cannot blow the
 * stack, and cycle-safe via the visited set.
 *
 * `traversable` decides whether to walk THROUGH a node. A node that fails it is
 * still in the result — it is an ancestor — but the walk does not continue past
 * it. Omit it to walk everything.
 */
function reachable(
  start: string,
  next: Map<string, string[]>,
  traversable: (id: string) => boolean = () => true
): Set<string> {
  const seen = new Set<string>();
  const stack = [...(next.get(start) ?? [])];

  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (traversable(id)) stack.push(...(next.get(id) ?? []));
  }

  return seen;
}

/**
 * Cycles by iterative depth-first search over the blocker edges, colouring nodes
 * white/grey/black. Reaching a grey node closes a cycle: the cycle is the
 * segment of the live path from that node on. Each cycle is reported once, keyed
 * by its node set.
 */
function findCycles(
  nodes: readonly GraphNode[],
  blockersOf: Map<string, string[]>
): string[][] {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>(nodes.map((node) => [node.id, WHITE]));

  const cycles: string[][] = [];
  const emitted = new Set<string>();

  for (const node of nodes) {
    if (colour.get(node.id) !== WHITE) continue;

    const path: string[] = [];
    // An `enter` frame descends into a node; its matching `exit` frame pops the
    // node off the path and blackens it, so `path` always mirrors the live DFS
    // stack — which is what makes the cycle segment below correct.
    const stack: {id: string; enter: boolean}[] = [{id: node.id, enter: true}];

    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) continue;

      if (!frame.enter) {
        path.pop();
        colour.set(frame.id, BLACK);
        continue;
      }

      const current = colour.get(frame.id);
      if (current === BLACK) continue;

      if (current === GREY) {
        const start = path.indexOf(frame.id);
        if (start >= 0) {
          const cycle = path.slice(start);
          const key = [...cycle].sort().join(' ');
          if (!emitted.has(key)) {
            emitted.add(key);
            cycles.push(cycle);
          }
        }
        continue;
      }

      colour.set(frame.id, GREY);
      path.push(frame.id);
      stack.push({id: frame.id, enter: false});

      for (const blocker of blockersOf.get(frame.id) ?? []) {
        if (colour.get(blocker) !== BLACK) {
          stack.push({id: blocker, enter: true});
        }
      }
    }
  }

  return cycles;
}
