import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage} from '../../lib/errors.mts';
import {availableTicket} from '../../lib/graph/document.mts';
import {frontier} from '../../lib/graph/queries.mts';
import {writeLine} from '../../lib/io.mts';
import {
  deriveOptions,
  resolveStaleAfterMs,
  STALE_AFTER_USAGE,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

/**
 * Print the next task to work — the top of the ranked available frontier — so an
 * agent need not read the whole document. With `--claim`, grab it atomically:
 * the store ranks and claims in one transaction, so two agents calling
 * `next --claim` cannot get the same task.
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
      const options = deriveOptions(config, staleAfterMs);

      if (agent === undefined) {
        const top = frontier(store.database, options, values.project)[0];
        if (top !== undefined)
          await writeLine(context.stdout, availableTicket(top));
        await context.log.info('next task', {task: top?.node.id ?? '-'});
        return;
      }

      const claimed = await store.claimNext(agent, options, values.project);

      if (claimed === null) {
        // Either the frontier was empty or every candidate is held live. No work
        // to hand out right now — not an error.
        await context.log.info('next task', {task: '-', claimed: false});
        return;
      }

      await writeLine(context.stdout, availableTicket(claimed.entry));
      await context.log.info('claimed next task', {
        task: claimed.entry.node.id,
        agent,
        outcome: claimed.outcome,
      });
    });
  },
};
