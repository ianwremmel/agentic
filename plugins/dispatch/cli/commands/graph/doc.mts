import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {UsageError} from '../../lib/errors.mts';
import {toJson, toXml} from '../../lib/graph/document.mts';
import type {ProjectCounts} from '../../lib/graph/types.mts';
import {writeLine} from '../../lib/io.mts';
import {
  deriveGraph,
  resolveStaleAfterMs,
  STALE_AFTER_USAGE,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

/** Emit the §2.6 project-graph document — the orchestrator's read path. */
export const doc: Command = {
  name: 'doc',
  summary: 'Emit the derived project-graph document on stdout.',
  usage: [
    'dispatch graph doc [--format xml|json] [--stale-after 10m]',
    '',
    'options:',
    '  --format <fmt>   xml (default) or json.',
    STALE_AFTER_USAGE,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        format: {type: 'string'},
        'stale-after': {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });

    const format = values.format ?? 'xml';
    assert(
      format === 'xml' || format === 'json',
      new UsageError(`unknown --format "${format}"`, {
        hint: 'use --format xml (the default) or --format json.',
      })
    );

    await withStore(values, context, async (store, config) => {
      const staleAfterMs = resolveStaleAfterMs(values['stale-after'], config);
      const graph = deriveGraph(store, config, staleAfterMs);

      await writeLine(
        context.stdout,
        format === 'xml' ? toXml(graph) : toJson(graph)
      );

      await context.log.info('emitted project-graph document', {
        format,
        nodes: graph.nodes.length,
        available: graph.available.length,
        blocked: graph.blocked.length,
        human_blocked: graph.humanBlocked.length,
        anomalies: graph.anomalies.length,
        terminal: isTerminal(graph.counts),
      });

      for (const anomaly of graph.anomalies) {
        await context.log.warn('graph anomaly', {
          kind: anomaly.kind,
          nodes: anomaly.nodes.join(','),
          detail: anomaly.detail,
        });
      }
    });
  },
};

/**
 * Whether every selected project is terminal (§2.6). A partial project (seen only
 * through a cross-project ancestor) is never terminal, so it is excluded; an empty
 * graph is not terminal either — `every` over no projects is vacuously true, which
 * would announce success on a fresh database.
 */
function isTerminal(counts: readonly ProjectCounts[]): boolean {
  const selected = counts.filter((count) => !count.partial);
  return selected.length > 0 && selected.every((count) => count.terminal);
}
