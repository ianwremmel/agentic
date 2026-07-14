import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage, UsageError} from '../../lib/errors.mts';
import {EXCLUSION_KIND_LIST, isExclusionKind} from '../../lib/graph/roles.mts';
import {writeLine} from '../../lib/io.mts';
import {group} from '../../lib/subcommand.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * The orchestrator's exclusions (§2.6 producer contract): the tickets it already
 * has in flight, is done with, or has failed.
 *
 * An exclusion keeps a ticket out of `available` — nothing more. The node keeps
 * updating on every sync, because the cache must not go stale on work that is in
 * flight, and the tracker's role stays authoritative for what the ticket *is*.
 */
const add: Command = {
  name: 'add',
  summary: 'Withhold a ticket from the available frontier.',
  usage: [
    'dispatch graph exclude add <ticket-id> --kind <kind>',
    '',
    'options:',
    `  --kind <kind>    One of: ${EXCLUSION_KIND_LIST}.`,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values, positionals} = parseArgsOrUsage({
      args: argv,
      options: {...STORE_OPTIONS, kind: {type: 'string'}},
      allowPositionals: true,
      strict: true,
    });

    const id = positionals[0];
    assertUsage(
      id !== undefined && positionals.length === 1,
      'exclude add takes exactly one ticket id'
    );

    const kind = values.kind;
    assert(
      kind !== undefined && isExclusionKind(kind),
      new UsageError(
        `exclude add needs a --kind, and "${kind ?? ''}" is not one`,
        {
          hint: `use --kind with one of: ${EXCLUSION_KIND_LIST}. in-flight = a coordinator owns it; done = the orchestrator has finished with it; failed = it cannot progress, and its dependents are permanently blocked.`,
        }
      )
    );

    await withStore(values, context, async (store) => {
      await store.addExclusion(id, kind);
      await context.log.info('excluded ticket', {ticket: id, kind});
    });
  },
};

const remove: Command = {
  name: 'remove',
  summary: 'Return a ticket to the frontier.',
  usage: ['dispatch graph exclude remove <ticket-id>', '', STORE_USAGE].join(
    '\n'
  ),

  async run(argv, context) {
    const {values, positionals} = parseArgsOrUsage({
      args: argv,
      options: STORE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });

    const id = positionals[0];
    assertUsage(
      id !== undefined && positionals.length === 1,
      'exclude remove takes exactly one ticket id'
    );

    await withStore(values, context, async (store) => {
      const removed = await store.removeExclusion(id);
      // Removing an exclusion that was never there is the desired end state, so
      // it succeeds — a reconciling tick must be able to run twice.
      await context.log.info('cleared exclusion', {
        ticket: id,
        existed: removed > 0,
      });
    });
  },
};

const list: Command = {
  name: 'list',
  summary: 'List the tickets currently withheld.',
  usage: ['dispatch graph exclude list', '', STORE_USAGE].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: STORE_OPTIONS,
      allowPositionals: false,
      strict: true,
    });

    await withStore(values, context, async (store) => {
      const exclusions = await store.listExclusions();
      for (const exclusion of exclusions) {
        await writeLine(context.stdout, `${exclusion.id} ${exclusion.kind}`);
      }
      await context.log.info('listed exclusions', {count: exclusions.length});
    });
  },
};

export const exclude = group({
  name: 'exclude',
  path: 'graph exclude',
  summary: 'Withhold in-flight, done, or failed tickets from the frontier.',
  children: [add, remove, list],
});
