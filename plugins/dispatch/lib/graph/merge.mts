/**
 * Folds a delta into the durable cache.
 *
 * Mechanical only — no graph reasoning happens here. Everything that could be
 * called a decision belongs to `derive`, so the cache stays a plain record of
 * what the tracker last said.
 */

import type {Delta, Edge, Graph} from './types.mts';

export const EMPTY: Graph = {cursor: null, projects: [], milestones: [], nodes: [], edges: []};

const keyOf = (edge: Edge): string => `${edge.blocker}>${edge.blocked}`;

/**
 * Merge `delta` into `cache` and return the new cache.
 *
 * @param cache the durable graph, or a fresh {@link EMPTY} on first run
 * @param delta one adapter fetch — a full sync replaces the cache wholesale
 */
export function merge(cache: Graph, delta: Delta): Graph {
  const base: Graph = delta.full ? structuredClone(EMPTY) : structuredClone(cache);
  const deletedNodes = new Set<string>();

  for (const collection of ['projects', 'milestones', 'nodes'] as const) {
    const by = new Map<string, {id: string}>((base[collection] as Array<{id: string}>).map((x) => [x.id, x]));
    for (const item of (delta[collection] ?? []) as Array<{id: string; removed?: boolean}>) {
      if (item.removed) {
        by.delete(item.id);
        if (collection === 'nodes') deletedNodes.add(item.id);
      } else {
        by.set(item.id, {...by.get(item.id), ...item});
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the map is keyed by the collection's own item type
    (base as any)[collection] = [...by.values()];
  }

  // A node whose edges the delta restates in full: drop every cached edge that
  // touches it first, so a dependency deleted in the tracker cannot survive.
  const restated = new Set(delta.edges_for ?? []);
  const edges = new Map<string, Edge>(
    base.edges
      .filter(
        (e) =>
          !restated.has(e.blocker) &&
          !restated.has(e.blocked) &&
          !deletedNodes.has(e.blocker) &&
          !deletedNodes.has(e.blocked),
      )
      .map((e) => [keyOf(e), e]),
  );
  for (const e of delta.edges ?? []) {
    if (e.removed) edges.delete(keyOf(e));
    else edges.set(keyOf(e), {blocker: e.blocker, blocked: e.blocked});
  }

  // An edge naming a node outside the synced set is *kept*: it means the blocker
  // lives elsewhere, and dropping it would report blocked work as ready. `derive`
  // blocks the dependent and raises an anomaly.
  base.edges = [...edges.values()];
  if (delta.cursor) base.cursor = delta.cursor;
  return base;
}
