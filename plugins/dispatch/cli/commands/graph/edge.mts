import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage, UsageError} from '../../lib/errors.mts';
import {group} from '../../lib/subcommand.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * One dependency edge. `--blocker` blocks `--blocked` — i.e. `--blocked` depends
 * on `--blocker` (§2.3). Endpoints may be tasks or milestones; an edge between a
 * task and a milestone is surfaced as an anomaly by `doc`.
 */
const add: Command = {
  name: 'add',
  summary: 'Add one dependency edge.',
  usage: [
    'dispatch graph edge add --blocker CLC-944 --blocked CLC-945',
    '',
    'options:',
    '  --blocker <id>   The id that must finish first.',
    '  --blocked <id>   The id that waits on it.',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {blocker, blocked, values} = twoEnds(argv, 'edge add');
    await withStore(values, context, async (store) => {
      const added = await store.addEdge(blocker, blocked);
      await context.log.info('added edge', {blocker, blocked, new: added});
    });
  },
};

const rm: Command = {
  name: 'rm',
  summary: 'Remove one dependency edge.',
  usage: [
    'dispatch graph edge rm --blocker CLC-944 --blocked CLC-945',
    '',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {blocker, blocked, values} = twoEnds(argv, 'edge rm');
    await withStore(values, context, async (store) => {
      const removed = await store.removeEdge(blocker, blocked);
      await context.log.info('removed edge', {
        blocker,
        blocked,
        existed: removed,
      });
    });
  },
};

/**
 * Replace every edge in one direction of a node — the primitive a re-fetch uses
 * to declare "these are now exactly my blockers" (or blocked) in one call.
 */
const set: Command = {
  name: 'set',
  summary: "Replace one node's edges in a single direction.",
  usage: [
    'dispatch graph edge set --blocked CLC-945 --blockers CLC-944,CLC-943',
    'dispatch graph edge set --blocker CLC-944 --blocks CLC-945,CLC-946',
    '',
    'Give exactly one of --blocked (with --blockers) or --blocker (with --blocks).',
    'An empty list clears that direction.',
    '',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        blocked: {type: 'string'},
        blockers: {type: 'string'},
        blocker: {type: 'string'},
        blocks: {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });

    const inbound =
      values.blocked !== undefined || values.blockers !== undefined;
    const outbound =
      values.blocker !== undefined || values.blocks !== undefined;
    assert(
      inbound !== outbound,
      new UsageError('edge set takes one direction at a time', {
        hint: 'either --blocked <id> --blockers a,b, or --blocker <id> --blocks a,b — not both.',
      })
    );

    const node = inbound ? values.blocked : values.blocker;
    assertUsage(
      node !== undefined && node !== '',
      inbound
        ? 'edge set --blocked needs a node id'
        : 'edge set --blocker needs a node id'
    );

    const others = splitIds(inbound ? values.blockers : values.blocks);

    await withStore(values, context, async (store) => {
      await store.setEdges(node, inbound ? 'blockers' : 'blocks', others);
      await context.log.info('set edges', {
        node,
        direction: inbound ? 'blockers' : 'blocks',
        count: others.length,
      });
    });
  },
};

function twoEnds(
  argv: string[],
  where: string
): {blocker: string; blocked: string; values: {db?: string; config?: string}} {
  const {values} = parseArgsOrUsage({
    args: argv,
    options: {
      ...STORE_OPTIONS,
      blocker: {type: 'string'},
      blocked: {type: 'string'},
    },
    allowPositionals: false,
    strict: true,
  });

  assertUsage(
    values.blocker !== undefined && values.blocker !== '',
    `${where} needs --blocker`
  );
  assertUsage(
    values.blocked !== undefined && values.blocked !== '',
    `${where} needs --blocked`
  );
  assert(
    values.blocker !== values.blocked,
    new UsageError(`${where}: a node cannot block itself`, {
      hint: 'a self-edge is an illegal one-node cycle (§2.3).',
    })
  );

  return {blocker: values.blocker, blocked: values.blocked, values};
}

function splitIds(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

export const edge = group({
  name: 'edge',
  path: 'graph edge',
  summary: 'Add, remove, or replace dependency edges.',
  children: [add, rm, set],
});
