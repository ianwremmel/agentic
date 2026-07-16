import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * Wipe the graph — tasks, edges, milestones, projects — for a full rebuild
 * (first run, or recovery). Claims, milestone reviews, and cursors survive: they
 * are the orchestrator's bookkeeping, not the tracker's to reset.
 */
export const reset: Command = {
  name: 'reset',
  summary: 'Clear the graph for a full rebuild (keeps claims and reviews).',
  usage: ['dispatch graph reset', '', STORE_USAGE].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: STORE_OPTIONS,
      allowPositionals: false,
      strict: true,
    });

    await withStore(values, context, async (store) => {
      await store.reset();
      await context.log.info('reset graph', {});
    });
  },
};
