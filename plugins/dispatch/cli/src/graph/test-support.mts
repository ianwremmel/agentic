import type { GraphNode, GraphSnapshot } from './types.mts';
import type { Role } from '../roles.mts';

export function node(
  id: string,
  role: Role,
  overrides: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    project: 'p1',
    url: `https://tracker.example/${id}`,
    title: id,
    role,
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

/** `blocker > blocked` — reads in the direction the protocol's edges point. */
export function edge(spec: string): { blocker: string; blocked: string } {
  const [blocker = '', blocked = ''] = spec.split('>').map((s) => s.trim());
  return { blocker, blocked };
}

export function snapshot(
  overrides: Partial<GraphSnapshot> = {},
): GraphSnapshot {
  return {
    projects: [{ id: 'p1', name: 'Project One', declared: true }],
    nodes: [],
    edges: [],
    milestones: [],
    exclusions: [],
    reviews: [],
    cursors: {},
    ...overrides,
  };
}
