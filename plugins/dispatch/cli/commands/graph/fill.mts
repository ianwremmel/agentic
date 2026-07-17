import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {UsageError} from '../../lib/errors.mts';
import {attr, availableTicket} from '../../lib/graph/document.mts';
import {milestoneStates} from '../../lib/graph/queries.mts';
import {writeLine} from '../../lib/io.mts';
import {mintAgentId} from './claim.mts';
import {
  deriveOptions,
  resolveStaleAfterMs,
  STALE_AFTER_USAGE,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

/**
 * One orchestrator tick's dispatch list, claims already taken. The CLI owns
 * every stateful step the tick needs — free-slot arithmetic, agent-id minting,
 * claim acquisition, review-lock acquisition — so the orchestrator only hands
 * the printed items to subagents.
 */
export const fill: Command = {
  name: 'fill',
  summary: 'Claim everything dispatchable this tick and print it, ids minted.',
  usage: [
    'dispatch graph fill [--project P] [--limit N] [--stale-after 10m]',
    '',
    'Prints the dispatch list for one tick, each item already claimed under a',
    'freshly minted agent id:',
    '',
    '  <dispatches slots-free="2" tickets="1" reviews="1">',
    '    <review milestone="M1" project="P" name="…" agent="review-M1-…"/>',
    '    <ticket id="CLC-945" agent="wt-…" target-kind="pr" url="…" [pass="…"] [branch-hint="…"]/>',
    '  </dispatches>',
    '',
    'Each <review> is a ready-for-review, unreviewed milestone whose review',
    'lock (its claim) was just taken — dispatch a milestone-review agent under',
    'the printed agent id. Each <ticket> is a claimed work item off the',
    'dispatch queue — dispatch a coordinator under its printed agent id; a',
    '`pass` attribute scopes a re-dispatch (resume, verify, finalize, retry).',
    '',
    'Tickets are admitted up to the free compute-slot count (the ledger size',
    'minus live held slots); workers still acquire slots themselves, so',
    'over-admission never overloads the host. Reviews are not slot-bounded.',
    'An empty <dispatches/> means nothing is dispatchable right now — not that',
    'the projects are done.',
    '',
    'options:',
    '  --project <id>  Restrict tickets to one project.',
    '  --limit <n>     Admit at most n tickets, instead of the free-slot count.',
    STALE_AFTER_USAGE,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        project: {type: 'string'},
        limit: {type: 'string'},
        'stale-after': {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });
    const limitFlag = parseLimit(values.limit);

    await withStore(values, context, async (store, config) => {
      const staleAfterMs = resolveStaleAfterMs(values['stale-after'], config);
      const options = deriveOptions(config, staleAfterMs);
      const nowMs = Date.now();

      const items: string[] = [];
      let reviews = 0;
      let tickets = 0;

      // Review locks first, mirroring gate-before-fill ordering: an opened
      // gate should dispatch its review the same tick its members finish.
      for (const state of milestoneStates(store.database, options)) {
        if (!state.readyForReview || state.reviewRecorded) continue;
        if (state.claim?.live === true) continue;
        const agent = mintAgentId(`review-${state.id}`);
        const result = await store.claim(state.id, agent, options);
        if (result.outcome !== 'claimed' && result.outcome !== 'reclaimed')
          continue;
        items.push(
          `  <review milestone="${attr(state.id)}" project="${attr(state.project)}" name="${attr(state.name)}" agent="${attr(agent)}"/>`
        );
        reviews += 1;
      }

      const held = await store.slots(nowMs, staleAfterMs);
      const live = held.filter((slot) => slot.live).length;
      const free = Math.max(0, config.maxParallel - live);
      const limit = limitFlag ?? free;

      for (let index = 0; index < limit; index += 1) {
        const agent = mintAgentId('wt');
        const claimed = await store.claimNext(agent, options, values.project);
        if (claimed === null) break;
        items.push(
          `  ${availableTicket(claimed.entry, undefined, claimed.pass, agent)}`
        );
        tickets += 1;
      }

      const open = `<dispatches slots-free="${String(free)}" tickets="${String(tickets)}" reviews="${String(reviews)}"`;
      await writeLine(
        context.stdout,
        items.length === 0
          ? `${open}/>`
          : [`${open}>`, ...items, '</dispatches>'].join('\n')
      );
      await context.log.info('filled dispatch list', {
        tickets,
        reviews,
        free,
      });
    });
  },
};

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  assert(
    Number.isInteger(n) && n >= 0,
    new UsageError(`--limit must be a non-negative integer, not "${raw}"`, {
      hint: 'e.g. --limit 2, or omit it to admit up to the free-slot count.',
    })
  );
  return n;
}
