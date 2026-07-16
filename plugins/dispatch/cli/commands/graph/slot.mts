import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {
  assertUsage,
  DataError,
  EnvironmentError,
  UsageError,
} from '../../lib/errors.mts';
import {writeLine} from '../../lib/io.mts';
import {group} from '../../lib/subcommand.mts';
import {
  resolveStaleAfterMs,
  STALE_AFTER_USAGE,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

const MAX_USAGE =
  "  --max <n>       Ledger size for this call (default: the config's maxParallel).";

/**
 * The compute-slot ledger: a slot is the right to write code, install, build,
 * or run tests on this host. Acquire before entering such a stage; release on
 * any wait (CI, review, merge, a human handoff) or exit. Stale holders are
 * swept at acquire time, so a crashed agent cannot leak capacity.
 */
const acquire: Command = {
  name: 'acquire',
  summary: 'Take a compute slot, or refresh one already held.',
  usage: [
    'dispatch graph slot acquire --agent <session-id> [--max 3] [--stale-after 10m]',
    '',
    'Exits 3 when every slot is held live — wait and retry.',
    '',
    'options:',
    "  --agent <id>    The acquiring agent's session id (required).",
    MAX_USAGE,
    STALE_AFTER_USAGE,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {agent, max, staleFlag, values} = slotArgs(argv, 'slot acquire');
    await withStore(values, context, async (store, config) => {
      const staleAfterMs = resolveStaleAfterMs(staleFlag, config);
      const outcome = await store.acquireSlot(
        agent,
        max ?? config.maxParallel,
        Date.now(),
        staleAfterMs
      );
      if (outcome === 'full') {
        throw new EnvironmentError('every compute slot is held live', {
          hint: 'wait for a slot to free (or go stale) and retry `dispatch graph slot acquire`.',
        });
      }
      await context.log.info('slot', {agent, outcome});
    });
  },
};

const release: Command = {
  name: 'release',
  summary: "Give an agent's compute slot back.",
  usage: [
    'dispatch graph slot release --agent <session-id>',
    '',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {agent, values} = slotArgs(argv, 'slot release');
    await withStore(values, context, async (store) => {
      const existed = await store.releaseSlot(agent);
      await context.log.info('released slot', {agent, existed});
    });
  },
};

const heartbeat: Command = {
  name: 'heartbeat',
  summary: "Refresh an agent's slot so it does not go stale.",
  usage: [
    'dispatch graph slot heartbeat --agent <session-id>',
    '',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {agent, values} = slotArgs(argv, 'slot heartbeat');
    await withStore(values, context, async (store) => {
      const ok = await store.heartbeatSlot(agent, Date.now());
      assert(
        ok,
        new DataError(`agent ${agent} holds no slot`, {
          hint: 'the slot may have gone stale and been reclaimed — stop computing and re-acquire with `dispatch graph slot acquire`.',
        })
      );
      await context.log.info('slot heartbeat', {agent});
    });
  },
};

const status: Command = {
  name: 'status',
  summary: 'Print the ledger: size, held slots, free capacity.',
  usage: [
    'dispatch graph slot status [--max 3] [--stale-after 10m]',
    '',
    'options:',
    MAX_USAGE,
    STALE_AFTER_USAGE,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        max: {type: 'string'},
        'stale-after': {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });
    const max = parseMax(values.max);

    await withStore(values, context, async (store, config) => {
      const staleAfterMs = resolveStaleAfterMs(values['stale-after'], config);
      const size = max ?? config.maxParallel;
      const held = await store.slots(Date.now(), staleAfterMs);
      const live = held.filter((slot) => slot.live).length;
      const out = [
        `<slots max="${String(size)}" held="${String(live)}" free="${String(Math.max(0, size - live))}">`,
        ...held.map(
          (slot) =>
            `  <slot agent="${slot.agent.replace(/"/g, '&quot;')}" live="${String(slot.live)}"/>`
        ),
        '</slots>',
      ];
      await writeLine(context.stdout, out.join('\n'));
      await context.log.info('slot status', {max: size, live});
    });
  },
};

function slotArgs(
  argv: string[],
  where: string
): {
  agent: string;
  max: number | undefined;
  staleFlag: string | undefined;
  values: {db?: string; config?: string};
} {
  const {values} = parseArgsOrUsage({
    args: argv,
    options: {
      ...STORE_OPTIONS,
      agent: {type: 'string'},
      max: {type: 'string'},
      'stale-after': {type: 'string'},
    },
    allowPositionals: false,
    strict: true,
  });
  assertUsage(
    values.agent !== undefined && values.agent !== '',
    `${where} needs --agent (the agent's session id)`
  );
  return {
    agent: values.agent,
    max: parseMax(values.max),
    staleFlag: values['stale-after'],
    values,
  };
}

function parseMax(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  assert(
    Number.isInteger(n) && n >= 1,
    new UsageError(`--max must be a positive integer, not "${raw}"`, {
      hint: 'e.g. --max 3, or omit it to use the config maxParallel.',
    })
  );
  return n;
}

export const slot = group({
  name: 'slot',
  summary: 'Acquire, release, and inspect compute slots (the build ledger).',
  children: [acquire, release, heartbeat, status],
});
