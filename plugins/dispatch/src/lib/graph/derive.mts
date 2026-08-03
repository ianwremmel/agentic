import type {Database} from '../db/database.mts';
import {anomalies} from './anomalies.mts';
import {classifiedItems, milestoneStates} from './queries.mts';
import {text} from './rows.mts';
import type {
  Classification,
  ClassificationCounts,
  ClassifiedItem,
  DeriveOptions,
  DerivedGraph,
  ProjectCounts,
} from './types.mts';

const OPEN: readonly Classification[] = [
  'available',
  'blocked',
  'human-blocked',
  'in-flight',
  'dormant',
];

/**
 * Assemble the derived graph. The reasoning — blocking, ranking, gating,
 * classification, anomalies — is the SQL in `pipeline.mts`; this only reads
 * those results and tallies counts, so no consumer re-derives anything.
 */
export async function derive(
  db: Database,
  options: DeriveOptions = {}
): Promise<DerivedGraph> {
  const items = await classifiedItems(db, options);
  const tickets = items.filter((entry) => entry.item.kind === 'ticket');
  const prompt = items.filter((entry) => entry.item.kind === 'pr');

  const allProjects = db
    .all(
      `SELECT n.external_id AS id, p.name FROM project p
       JOIN node n ON n.id = p.node_id ORDER BY id`
    )
    .map((row) => ({id: text(row.id) ?? '', name: text(row.name) ?? ''}));

  const isTerminal = (project: string): boolean =>
    !tickets.some(
      (entry) =>
        entry.item.project === project && OPEN.includes(entry.classification)
    );

  const projects = allProjects.map((project) => ({
    ...project,
    terminal: isTerminal(project.id),
  }));

  return {
    projects,
    items: tickets,
    milestones: await milestoneStates(db, options),
    counts: allProjects.map((project): ProjectCounts => ({
      project: project.id,
      total: tickets.filter((entry) => entry.item.project === project.id)
        .length,
      ...tally(tickets.filter((entry) => entry.item.project === project.id)),
      terminal: isTerminal(project.id),
    })),
    prompt,
    anomalies: await anomalies(db),
    terminal:
      projects.every((project) => project.terminal) &&
      !prompt.some((entry) => OPEN.includes(entry.classification)),
  };
}

function tally(entries: readonly ClassifiedItem[]): ClassificationCounts {
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
