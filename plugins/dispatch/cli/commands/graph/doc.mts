import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {UsageError} from '../../lib/errors.mts';
import {derive, type ProjectCounts} from '../../lib/graph/derive.mts';
import {toJson, toXml} from '../../lib/graph/document.mts';
import {writeLine} from '../../lib/io.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * Emit the §2.6 project-graph document — the orchestrator's read path, and the
 * only view of project state it is allowed to act on.
 */
export const doc: Command = {
  name: 'doc',
  summary: 'Emit the derived project-graph document on stdout.',
  usage: [
    'dispatch graph doc [--format xml|json]',
    '',
    'options:',
    '  --format <fmt>   xml (default) or json.',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {...STORE_OPTIONS, format: {type: 'string'}},
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
      const snapshot = await store.snapshot();
      const graph = derive(snapshot, {parkedRoles: config.parkedRoles});

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
        permanently_blocked: graph.permanentlyBlocked.length,
        anomalies: graph.anomalies.length,
        terminal: isTerminal(graph.counts),
      });

      // Anomalies are illegal states (§2.3), not scheduling facts: the document
      // carries them, and the log makes sure they are seen even when the caller
      // only skims the derived sections.
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
 * Whether every selected project is terminal (§2.6 termination).
 *
 * Judged on the projects that were actually selected. A partial project — one
 * seen only through a cross-project ancestor — is never terminal by
 * construction, so counting it would report `terminal=false` forever on any
 * graph that reaches outside itself. An empty graph is not terminal either:
 * `every` over no projects is vacuously true, which would announce success on a
 * database nobody has ingested into yet.
 */
function isTerminal(counts: readonly ProjectCounts[]): boolean {
  const selected = counts.filter((count) => !count.partial);
  return selected.length > 0 && selected.every((count) => count.terminal);
}
