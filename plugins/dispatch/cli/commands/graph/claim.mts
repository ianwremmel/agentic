import assert from 'node:assert';
import {randomBytes} from 'node:crypto';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage, DataError, EnvironmentError} from '../../lib/errors.mts';
import {attr} from '../../lib/graph/document.mts';
import type {CheckoutInfo} from '../../lib/graph/store.mts';
import {writeLine} from '../../lib/io.mts';
import {
  deriveOptions,
  resolveStaleAfterMs,
  STALE_AFTER_USAGE,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

const CHECKOUT_USAGE =
  '  --worktree <p>  Where the work is checked out; recorded on the claim.\n' +
  '  --branch <b>    The working branch; recorded on the claim.';

/** A fresh agent id, unique across concurrent minters on one host. */
export function mintAgentId(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${randomBytes(4).toString('hex')}`;
}

/**
 * Claim a task or milestone for an agent. Succeeds if the item is dispatchable
 * (an available or pass-eligible task, or a ready-unreviewed milestone — the
 * review agent's lock), if the caller already holds it (a heartbeat), or if
 * the current holder's claim is stale (a takeover). Fails if another agent
 * holds it live.
 */
export const claim: Command = {
  name: 'claim',
  summary: 'Claim a task or milestone for an agent, or reclaim a stale one.',
  usage: [
    'dispatch graph claim --id CLC-945 [--agent <session-id>] [--stale-after 10m]',
    '',
    'Prints the taken claim as XML:',
    '  <claim id="CLC-945" agent="wt-…" outcome="claimed|refreshed|reclaimed"/>',
    'Without --agent a fresh agent id is minted; use the printed one for every',
    'later heartbeat, outcome, and slot call.',
    '',
    'options:',
    '  --id <id>       Task (or milestone, for a review lock) to claim (required).',
    "  --agent <id>    The claiming agent's session id (default: minted).",
    CHECKOUT_USAGE,
    STALE_AFTER_USAGE,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {id, agent, staleFlag, checkout, values} = claimArgs(argv, 'claim', {
      mintAgent: true,
    });
    assert(id !== undefined, 'claim always parses an id');

    await withStore(values, context, async (store, config) => {
      const staleAfterMs = resolveStaleAfterMs(staleFlag, config);
      const result = await store.claim(
        id,
        agent,
        deriveOptions(config, staleAfterMs),
        checkout
      );

      switch (result.outcome) {
        case 'claimed':
        case 'refreshed':
        case 'reclaimed':
          await writeLine(
            context.stdout,
            `<claim id="${attr(id)}" agent="${attr(agent)}" outcome="${result.outcome}"/>`
          );
          await context.log.info('claimed task', {
            task: id,
            agent,
            outcome: result.outcome,
          });
          return;
        case 'held':
          throw new EnvironmentError(
            `${id} is held by a live claim from agent ${result.heldBy ?? '?'}`,
            {
              hint: 'retry once its claim goes stale, or take a different task with `dispatch graph next`.',
            }
          );
        case 'not-available':
          throw new DataError(
            result.classification === undefined
              ? `${id} is not claimable`
              : `${id} is not claimable (state=${result.classification})`,
            {
              hint: 'claim a dispatchable task (`dispatch graph next` returns one) or a ready-unreviewed milestone.',
            }
          );
        case 'unknown-task':
          throw new DataError(`no task "${id}" in the graph`, {
            hint: 'fetch it into the graph (task set) before claiming it.',
          });
        default:
          return;
      }
    });
  },
};

/**
 * Keep everything an agent holds alive. With `--id`, refresh that one claim;
 * without it, refresh every claim the agent holds and its compute slot in one
 * write, so a worker's whole footprint stays live off a single call.
 */
export const heartbeat: Command = {
  name: 'heartbeat',
  summary: "Refresh an agent's claims and slot so they do not go stale.",
  usage: [
    'dispatch graph heartbeat --agent <session-id> [--id CLC-945]',
    '',
    'Without --id, one call refreshes every claim the agent holds and its',
    'compute slot, and prints what it touched:',
    '  <heartbeat agent="wt-…" claims="1" slot="true"/>',
    'With --id, only that claim is refreshed (nothing is printed).',
    '',
    'options:',
    '  --id <id>       Refresh only the claim on this task or milestone.',
    "  --agent <id>    The holding agent's session id (required).",
    CHECKOUT_USAGE,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {id, agent, checkout, values} = claimArgs(argv, 'heartbeat', {
      optionalId: true,
    });

    await withStore(values, context, async (store) => {
      if (id === undefined) {
        const touched = await store.heartbeatAgent(agent, Date.now(), checkout);
        assert(
          touched.claims > 0 || touched.slot,
          new DataError(`agent ${agent} holds no claim and no slot`, {
            hint: 'the claim may have gone stale and been reclaimed — stop work and re-acquire with `dispatch graph next` or `claim`.',
          })
        );
        await writeLine(
          context.stdout,
          `<heartbeat agent="${attr(agent)}" claims="${String(touched.claims)}" slot="${String(touched.slot)}"/>`
        );
        await context.log.info('heartbeat', {
          agent,
          claims: touched.claims,
          slot: touched.slot,
        });
        return;
      }

      const ok = await store.heartbeat(id, agent, Date.now(), checkout);
      assert(
        ok,
        new DataError(`agent ${agent} holds no claim on ${id}`, {
          hint: 'the claim may have gone stale and been reclaimed — stop work and re-acquire with `dispatch graph next` or `claim`.',
        })
      );
      await context.log.info('heartbeat', {task: id, agent});
    });
  },
};

/** Give a claim back. Idempotent; refuses to release another agent's claim. */
export const release: Command = {
  name: 'release',
  summary: "Release an agent's claim on a task.",
  usage: [
    'dispatch graph release --id CLC-945 --agent <session-id>',
    '',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {id, agent, values} = claimArgs(argv, 'release', {});
    assert(id !== undefined, 'release always parses an id');

    await withStore(values, context, async (store) => {
      const outcome = await store.release(id, agent);
      assert(
        outcome !== 'not-yours',
        new DataError(`${id} is claimed by another agent, not ${agent}`, {
          hint: 'an agent releases only its own claim; a stale one is reclaimed, not released.',
        })
      );
      await context.log.info('released claim', {
        task: id,
        agent,
        existed: outcome === 'released',
      });
    });
  },
};

function claimArgs(
  argv: string[],
  where: string,
  modes: {mintAgent?: boolean; optionalId?: boolean}
): {
  id: string | undefined;
  agent: string;
  staleFlag: string | undefined;
  checkout: CheckoutInfo | undefined;
  values: {db?: string; config?: string};
} {
  const {values} = parseArgsOrUsage({
    args: argv,
    options: {
      ...STORE_OPTIONS,
      id: {type: 'string'},
      agent: {type: 'string'},
      worktree: {type: 'string'},
      branch: {type: 'string'},
      'stale-after': {type: 'string'},
    },
    allowPositionals: false,
    strict: true,
  });

  // An explicitly empty flag is an error, never a silent fallback: `--id ""`
  // must not widen a heartbeat to agent scope, and `--agent ""` must not mint.
  if (values.id !== undefined) {
    assertUsage(values.id.trim() !== '', `${where}: --id must not be empty`);
  }
  if (values.agent !== undefined) {
    assertUsage(
      values.agent.trim() !== '',
      `${where}: --agent must not be empty`
    );
  }
  assertUsage(
    modes.optionalId === true || values.id !== undefined,
    `${where} needs --id`
  );
  assertUsage(
    modes.mintAgent === true || values.agent !== undefined,
    `${where} needs --agent (the agent's session id)`
  );
  const agent = values.agent ?? mintAgentId('wt');

  const checkout: CheckoutInfo = {};
  if (values.worktree !== undefined) {
    assertUsage(
      values.worktree.trim() !== '',
      `${where}: --worktree must name a path, not be empty`
    );
    checkout.worktree = values.worktree;
  }
  if (values.branch !== undefined) {
    assertUsage(
      values.branch.trim() !== '',
      `${where}: --branch must name a branch, not be empty`
    );
    checkout.branch = values.branch;
  }

  return {
    id: values.id,
    agent,
    staleFlag: values['stale-after'],
    checkout:
      checkout.worktree === undefined && checkout.branch === undefined
        ? undefined
        : checkout,
    values,
  };
}
