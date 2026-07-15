import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage} from '../../lib/errors.mts';
import {group} from '../../lib/subcommand.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * A selected project. Declaring it is what lets the document call it terminal: a
 * project only *referenced* by a cross-project ancestor stays partial, because
 * only the tickets on the dependency path were fetched.
 */
const set: Command = {
  name: 'set',
  summary: 'Declare or rename a project.',
  usage: [
    'dispatch graph project set --id P --name "My Project"',
    '',
    'options:',
    '  --id <id>      Project identifier (required).',
    '  --name <name>  Display name (default: the id).',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {...STORE_OPTIONS, id: {type: 'string'}, name: {type: 'string'}},
      allowPositionals: false,
      strict: true,
    });

    const id = values.id;
    assertUsage(id !== undefined && id !== '', 'project set needs --id');

    await withStore(values, context, async (store) => {
      await store.upsertProject({id, name: values.name ?? id});
      await context.log.info('set project', {project: id});
    });
  },
};

const rm: Command = {
  name: 'rm',
  summary: 'Forget a project (its tasks are left alone).',
  usage: ['dispatch graph project rm --id P', '', STORE_USAGE].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {...STORE_OPTIONS, id: {type: 'string'}},
      allowPositionals: false,
      strict: true,
    });

    const id = values.id;
    assertUsage(id !== undefined && id !== '', 'project rm needs --id');

    await withStore(values, context, async (store) => {
      const removed = await store.removeProject(id);
      await context.log.info('removed project', {
        project: id,
        existed: removed,
      });
    });
  },
};

export const project = group({
  name: 'project',
  path: 'graph project',
  summary: 'Declare the projects the graph spans.',
  children: [set, rm],
});
