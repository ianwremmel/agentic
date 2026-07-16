import {GraphStore} from './store.mts';
import type {GraphNode, Milestone} from './types.mts';

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

export interface SeedSpec {
  projects?: {id: string; name: string}[];
  milestones?: Milestone[];
  nodes?: GraphNode[];
  /** `[blocker, blocked]` — the blocker blocks the blocked. */
  edges?: [string, string][];
}

/**
 * An in-memory store holding the given graph, written through the real write
 * surface so every test also exercises its validation. Milestones land before
 * tasks so membership references resolve to declared milestones.
 */
export async function seededStore(spec: SeedSpec = {}): Promise<GraphStore> {
  const store = await GraphStore.open(':memory:');
  for (const project of spec.projects ?? [{id: 'P', name: 'Project'}]) {
    await store.upsertProject(project);
  }
  for (const milestone of spec.milestones ?? []) {
    await store.upsertMilestone(milestone);
  }
  for (const task of spec.nodes ?? []) {
    await store.upsertTask(task);
  }
  for (const [blocker, blocked] of spec.edges ?? []) {
    await store.addEdge(blocker, blocked);
  }
  return store;
}
