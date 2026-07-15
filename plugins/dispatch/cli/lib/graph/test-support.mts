import type {GraphEdge, GraphNode, GraphSnapshot} from './types.mts';

/** A ticket with everything defaulted, so a test states only what it is about. */
export function node(
  id: string,
  overrides: Partial<GraphNode> = {}
): GraphNode {
  return {
    id,
    project: 'P',
    url: `https://tracker.example/${id}`,
    title: id,
    role: 'available',
    milestone: null,
    targetKind: 'pr',
    humanInteractive: false,
    injected: false,
    priority: null,
    branchHint: null,
    labels: [],
    updatedAt: null,
    ...overrides,
  };
}

/** `A blocks B` — the direction the protocol names (§2.3). */
export function edge(blocker: string, blocked: string): GraphEdge {
  return {blocker, blocked};
}

export function snapshot(
  overrides: Partial<GraphSnapshot> = {}
): GraphSnapshot {
  return {
    projects: [{id: 'P', name: 'Project', declared: true}],
    nodes: [],
    edges: [],
    milestones: [],
    claims: [],
    reviews: [],
    cursors: {},
    ...overrides,
  };
}
