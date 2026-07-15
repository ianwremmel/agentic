import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage} from '../../lib/errors.mts';
import {availableTicket} from '../../lib/graph/document.mts';
import {writeLine} from '../../lib/io.mts';
import {
  deriveGraph,
  resolveStaleAfterMs,
  STALE_AFTER_USAGE,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

/**
 * Print the next task to work — the top of the ranked available frontier — so an
 * agent need not read the whole document. With `--claim`, grab it atomically:
 * derive, then claim the first candidate no live agent holds, in one transaction,
 * so two agents calling `next --claim` cannot get the same task.
 *
 * Prints one `<ticket>` element — the same shape the document uses — or nothing
 * when the frontier is empty. Empty output plus exit 0 is the "no work right now"
 * signal.
 */
export const next: Command = {
  name: 'next',
  summary: 'Print (and optionally claim) the next available task.',
  usage: [
    'dispatch graph next [--project P]',
    'dispatch graph next --claim --agent <session-id> [--project P] [--stale-after 10m]',
    '',
    'options:',
    '  --project <id>  Restrict to one project.',
    '  --claim         Claim the task atomically as it is picked.',
    "  --agent <id>    Required with --claim: the claiming agent's session id.",
    STALE_AFTER_USAGE,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        project: {type: 'string'},
        claim: {type: 'boolean'},
        agent: {type: 'string'},
        'stale-after': {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });

    const agent = values.claim === true ? values.agent : undefined;
    if (values.claim === true) {
      assertUsage(
        agent !== undefined && agent !== '',
        "next --claim needs --agent (the agent's session id)"
      );
    }

    await withStore(values, context, async (store, config) => {
      const staleAfterMs = resolveStaleAfterMs(values['stale-after'], config);
      const graph = await deriveGraph(store, config, staleAfterMs);

      const frontier = graph.available.filter(
        (entry) =>
          values.project === undefined || entry.node.project === values.project
      );

      if (agent === undefined) {
        const top = frontier[0];
        if (top !== undefined)
          await writeLine(context.stdout, availableTicket(top));
        await context.log.info('next task', {task: top?.node.id ?? '-'});
        return;
      }

      const claimed = await store.claimNext(
        frontier.map((entry) => entry.node.id),
        agent,
        Date.now(),
        staleAfterMs
      );

      if (claimed === null) {
        // Either the frontier was empty or every candidate is held live. No work
        // to hand out right now — not an error.
        await context.log.info('next task', {task: '-', claimed: false});
        return;
      }

      const entry = frontier.find(
        (candidate) => candidate.node.id === claimed.id
      );
      if (entry !== undefined)
        await writeLine(context.stdout, availableTicket(entry));
      await context.log.info('claimed next task', {
        task: claimed.id,
        agent,
        outcome: claimed.outcome,
      });
    });
  },
};
