import {group} from '../lib/subcommand.mts';
import {cursor} from './graph/cursor.mts';
import {doc} from './graph/doc.mts';
import {exclude} from './graph/exclude.mts';
import {ingest} from './graph/ingest.mts';
import {recordReview} from './graph/record-review.mts';

/**
 * The §2.6 producer, split between an agent and this CLI: a skill fetches from
 * the tracker and normalizes what it finds, `ingest` merges that into the durable
 * graph, and `doc` derives the project-graph document from it.
 *
 * The reasoning lives here rather than in the skill because effective-blocking,
 * ranking, and cycle detection have to give the same answer every tick, and an
 * agent re-deriving them from a prompt does not.
 */
export const graph = group({
  name: 'graph',
  summary: 'Build and query the project dependency graph.',
  children: [ingest, doc, cursor, exclude, recordReview],
});
