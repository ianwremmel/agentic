import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage, DataError} from '../../lib/errors.mts';
import {toMilestoneXml} from '../../lib/graph/document.mts';
import {writeLine} from '../../lib/io.mts';
import {group} from '../../lib/subcommand.mts';
import {
  deriveGraph,
  resolveStaleAfterMs,
  STALE_AFTER_USAGE,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

/**
 * Upsert one milestone. Milestones carry no order: sequence them with `edge add`
 * between milestones (`M1` blocks `M2`), so a milestone can have several
 * predecessors. Tasks join a milestone via `task set --milestone`.
 */
const set: Command = {
  name: 'set',
  summary: 'Create or update one milestone.',
  usage: [
    'dispatch graph milestone set --id M1 --project P --name "M1"',
    '',
    'options:',
    '  --id <id>       Milestone identifier (required).',
    '  --project <id>  Project it belongs to (required).',
    '  --name <name>   Display name (default: the id).',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        id: {type: 'string'},
        project: {type: 'string'},
        name: {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });

    const id = values.id;
    const projectId = values.project;
    assertUsage(id !== undefined && id !== '', 'milestone set needs --id');
    assertUsage(
      projectId !== undefined && projectId !== '',
      'milestone set needs --project'
    );

    await withStore(values, context, async (store) => {
      await store.upsertMilestone({
        id,
        project: projectId,
        name: values.name ?? id,
      });
      await context.log.info('set milestone', {
        milestone: id,
        project: projectId,
      });
    });
  },
};

const rm: Command = {
  name: 'rm',
  summary: 'Delete a milestone and its edges.',
  usage: ['dispatch graph milestone rm --id M1', '', STORE_USAGE].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {...STORE_OPTIONS, id: {type: 'string'}},
      allowPositionals: false,
      strict: true,
    });

    const id = values.id;
    assertUsage(id !== undefined && id !== '', 'milestone rm needs --id');

    await withStore(values, context, async (store) => {
      const removed = await store.removeMilestone(id);
      await context.log.info('removed milestone', {
        milestone: id,
        existed: removed,
      });
    });
  },
};

/**
 * One milestone's derived view: the gate state plus its member nodes. The
 * milestone-review agent's read — it judges exactly these members, so the
 * command hands them over rather than making the caller filter `doc`.
 */
const show: Command = {
  name: 'show',
  summary: "Print one milestone's gate state and member nodes.",
  usage: [
    'dispatch graph milestone show --id M1',
    '',
    'options:',
    '  --id <id>   Milestone identifier (required).',
    STALE_AFTER_USAGE,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        id: {type: 'string'},
        'stale-after': {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });

    const id = values.id;
    assertUsage(id !== undefined && id !== '', 'milestone show needs --id');

    await withStore(values, context, async (store, config) => {
      const staleAfterMs = resolveStaleAfterMs(values['stale-after'], config);
      const graph = deriveGraph(store, config, staleAfterMs);
      const xml = toMilestoneXml(graph, id);
      assert(
        xml !== null,
        new DataError(`no milestone "${id}" in the graph`, {
          hint: 'write it first (`dispatch graph milestone set`), or refresh the graph from the tracker.',
        })
      );
      await writeLine(context.stdout, xml);
      await context.log.info('emitted milestone', {milestone: id});
    });
  },
};

export const milestone = group({
  name: 'milestone',
  path: 'graph milestone',
  summary: 'Create, update, show, or delete milestones.',
  children: [set, rm, show],
});
