import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage, DataError, EnvironmentError} from '../../lib/errors.mts';
import {
  deriveOptions,
  resolveStaleAfterMs,
  STALE_AFTER_USAGE,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

/**
 * Claim a task for an agent. Succeeds if the task is free and available, if the
 * caller already holds it (a heartbeat), or if the current holder's claim is
 * stale (a takeover). Fails if another agent holds it live.
 */
export const claim: Command = {
  name: 'claim',
  summary: 'Claim a task for an agent, or reclaim a stale one.',
  usage: [
    'dispatch graph claim --id CLC-945 --agent <session-id> [--stale-after 10m]',
    '',
    'options:',
    '  --id <id>       Task to claim (required).',
    "  --agent <id>    The claiming agent's session id (required).",
    STALE_AFTER_USAGE,
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {id, agent, staleFlag, values} = claimArgs(argv, 'claim');

    await withStore(values, context, async (store, config) => {
      const staleAfterMs = resolveStaleAfterMs(staleFlag, config);
      const result = await store.claim(
        id,
        agent,
        deriveOptions(config, staleAfterMs)
      );

      switch (result.outcome) {
        case 'claimed':
        case 'refreshed':
        case 'reclaimed':
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
            `${id} is not available (state=${result.classification ?? 'unknown'})`,
            {
              hint: 'claim only an available task; `dispatch graph next` returns one.',
            }
          );
        case 'unknown-task':
          throw new DataError(`no task "${id}" in the graph`, {
            hint: 'add it with `dispatch graph task set` before claiming it.',
          });
        default:
          return;
      }
    });
  },
};

/** Keep a held claim alive. Fails if the caller no longer holds it. */
export const heartbeat: Command = {
  name: 'heartbeat',
  summary: "Refresh an agent's claim so it does not go stale.",
  usage: [
    'dispatch graph heartbeat --id CLC-945 --agent <session-id>',
    '',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {id, agent, values} = claimArgs(argv, 'heartbeat');

    await withStore(values, context, async (store) => {
      const ok = await store.heartbeat(id, agent, Date.now());
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
    const {id, agent, values} = claimArgs(argv, 'release');

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
  where: string
): {
  id: string;
  agent: string;
  staleFlag: string | undefined;
  values: {db?: string; config?: string};
} {
  const {values} = parseArgsOrUsage({
    args: argv,
    options: {
      ...STORE_OPTIONS,
      id: {type: 'string'},
      agent: {type: 'string'},
      'stale-after': {type: 'string'},
    },
    allowPositionals: false,
    strict: true,
  });

  assertUsage(
    values.id !== undefined && values.id !== '',
    `${where} needs --id`
  );
  assertUsage(
    values.agent !== undefined && values.agent !== '',
    `${where} needs --agent (the agent's session id)`
  );

  return {
    id: values.id,
    agent: values.agent,
    staleFlag: values['stale-after'],
    values,
  };
}
