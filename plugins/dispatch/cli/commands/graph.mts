import {group} from '../lib/subcommand.mts';
import {claim, heartbeat, release} from './graph/claim.mts';
import {cursor} from './graph/cursor.mts';
import {doc} from './graph/doc.mts';
import {edge} from './graph/edge.mts';
import {milestone} from './graph/milestone.mts';
import {next} from './graph/next.mts';
import {project} from './graph/project.mts';
import {recordReview} from './graph/record-review.mts';
import {reset} from './graph/reset.mts';
import {task} from './graph/task.mts';

/**
 * The §2.6 producer, split between an agent and this CLI: a skill fetches from the
 * tracker and writes what it finds through the typed `project`/`task`/`edge`/
 * `milestone` commands, and `doc` derives the project-graph document from the
 * store. The reasoning lives here rather than in the skill because
 * effective-blocking, ranking, cycle detection, and milestone gating have to give
 * the same answer every tick.
 *
 * `next` and the claim lifecycle (`claim`/`heartbeat`/`release`) live here too:
 * this store is the orchestrator's state, so "who owns which task" belongs beside
 * the graph it is derived against.
 */
export const graph = group({
  name: 'graph',
  summary:
    'Build, query, and coordinate work over the project dependency graph.',
  children: [
    project,
    task,
    edge,
    milestone,
    doc,
    next,
    claim,
    heartbeat,
    release,
    reset,
    cursor,
    recordReview,
  ],
});
