import type {Database} from '../db/database.mts';
import {
  anomalies,
  classifiedNodes,
  cursors,
  edges,
  frontier,
  milestoneStates,
  projects,
  type DeriveOptions,
} from './queries.mts';
import type {
  Classification,
  ClassificationCounts,
  ClassifiedNode,
  DerivedGraph,
  MilestoneCounts,
  MilestoneState,
  ProjectCounts,
} from './types.mts';

export type {DeriveOptions} from './queries.mts';

const OPEN: readonly Classification[] = [
  'available',
  'blocked',
  'human-blocked',
  'in-flight',
  'dormant',
];

/**
 * Assemble the derived project-graph document. The graph reasoning — blocking,
 * ranking, gating, classification, anomalies — is the SQL in `queries.mts`;
 * this only reads those results and tallies the counts, so the orchestrator
 * that consumes the document never re-derives anything.
 */
export function derive(
  db: Database,
  options: DeriveOptions = {}
): DerivedGraph {
  const classified = classifiedNodes(db, options);
  const available = frontier(db, options);
  const milestones = milestoneStates(db, options);
  const allProjects = projects(db);

  const bucket = (kind: Classification): ClassifiedNode[] =>
    classified.filter((entry) => entry.classification === kind);

  return {
    projects: allProjects.map((project) => ({
      id: project.id,
      name: project.name,
      partial: !project.declared,
      terminal: project.declared && isTerminalProject(classified, project.id),
    })),
    nodes: classified,
    edges: edges(db),
    available,
    blocked: bucket('blocked'),
    humanBlocked: bucket('human-blocked'),
    milestones: milestones.map((milestone) =>
      countMilestone(classified, milestone)
    ),
    counts: allProjects.map((project) => ({
      project: project.id,
      partial: !project.declared,
      total: classified.filter((entry) => entry.node.project === project.id)
        .length,
      ...tally(classified.filter((entry) => entry.node.project === project.id)),
      terminal: project.declared && isTerminalProject(classified, project.id),
    })) satisfies ProjectCounts[],
    anomalies: anomalies(db),
    cursors: cursors(db),
  };
}

function isTerminalProject(
  classified: readonly ClassifiedNode[],
  project: string
): boolean {
  return !classified.some(
    (entry) =>
      entry.node.project === project && OPEN.includes(entry.classification)
  );
}

function tally(entries: readonly ClassifiedNode[]): ClassificationCounts {
  const count = (kind: Classification): number =>
    entries.filter((entry) => entry.classification === kind).length;

  return {
    available: count('available'),
    blocked: count('blocked'),
    humanBlocked: count('human-blocked'),
    inFlight: count('in-flight'),
    dormant: count('dormant'),
    verified: count('verified'),
    canceled: count('canceled'),
  };
}

function countMilestone(
  classified: readonly ClassifiedNode[],
  milestone: MilestoneState
): MilestoneCounts {
  const members = new Set(milestone.members);
  return {
    ...milestone,
    ...tally(classified.filter((entry) => members.has(entry.node.id))),
  };
}
