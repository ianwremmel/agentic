import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {toSummaryXml} from '../../lib/graph/document.mts';
import {dispatchQueue} from '../../lib/graph/queries.mts';
import {writeLine} from '../../lib/io.mts';
import {
  deriveGraph,
  deriveOptions,
  resolveStaleAfterMs,
  STALE_AFTER_USAGE,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

/**
 * The orchestrator's per-tick read: derived sections only. The full document
 * (`doc`, nodes and edges included) exists for debugging and export; a
 * scheduling decision never needs it.
 */
export const summary: Command = {
  name: 'summary',
  summary: 'Print the derived scheduling summary (no nodes or edges).',
  usage: [
    'dispatch graph summary [--stale-after 10m]',
    '',
    'options:',
    STALE_AFTER_USAGE,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {...STORE_OPTIONS, 'stale-after': {type: 'string'}},
      allowPositionals: false,
      strict: true,
    });

    await withStore(values, context, async (store, config) => {
      const staleAfterMs = resolveStaleAfterMs(values['stale-after'], config);
      const options = deriveOptions(config, staleAfterMs);
      const graph = deriveGraph(store, config, staleAfterMs);
      const queue = dispatchQueue(store.database, options);
      const nowMs = Date.now();
      const counts = {
        available: queue.filter((item) => item.pass === null).length,
        resume: queue.filter((item) => item.pass === 'resume').length,
        verify: queue.filter((item) => item.pass === 'verify').length,
        finalize: queue.filter((item) => item.pass === 'finalize').length,
        retry: queue.filter((item) => item.pass === 'retry').length,
        liveClaims: await store.liveClaimCount(nowMs, staleAfterMs),
      };
      const held = await store.slots(nowMs, staleAfterMs);

      await writeLine(
        context.stdout,
        toSummaryXml(graph, counts, {max: config.maxParallel, held})
      );
      await context.log.info('emitted summary', {
        queued: queue.length,
        terminal: graph.counts.every(
          (count) => count.partial || count.terminal
        ),
      });
    });
  },
};
