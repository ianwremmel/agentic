import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage, UsageError} from '../../lib/errors.mts';
import {isOutcome, OUTCOMES} from '../../lib/graph/store.mts';
import {group} from '../../lib/subcommand.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * A coordinator's final report on its work item. Recording one releases the
 * recorder's claim in the same transaction and is what re-admits the node to
 * the dispatch queue for its follow-up pass (verify, finalize, retry).
 */
const set: Command = {
  name: 'set',
  summary: "Record a coordinator's final outcome on a task.",
  usage: [
    'dispatch graph outcome set --id CLC-945 --agent <session-id> --outcome delivered',
    'dispatch graph outcome set --id CLC-945 --agent <session-id> --outcome failed \\',
    '    --retryable false --detail "suite target unreachable"',
    '',
    'Write it as your final action; it also releases your claim and any',
    'compute slot you hold. Refused if another agent now holds the claim.',
    '',
    'options:',
    '  --id <id>          Task the outcome is about (required).',
    "  --agent <id>       The reporting agent's session id (required).",
    `  --outcome <o>      One of: ${OUTCOMES.join(', ')} (required).`,
    '  --retryable <b>    true|false; only with --outcome failed.',
    '  --detail <text>    One-line reason or note.',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        id: {type: 'string'},
        agent: {type: 'string'},
        outcome: {type: 'string'},
        retryable: {type: 'string'},
        detail: {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });
    assertUsage(
      values.id !== undefined && values.id !== '',
      'outcome set needs --id'
    );
    assertUsage(
      values.agent !== undefined && values.agent !== '',
      "outcome set needs --agent (the agent's session id)"
    );
    const outcome = values.outcome ?? '';
    assert(
      isOutcome(outcome),
      new UsageError(`"${outcome}" is not an outcome`, {
        hint: `use --outcome with one of: ${OUTCOMES.join(', ')}.`,
      })
    );
    const retryable = parseRetryable(values.retryable);

    await withStore(values, context, async (store) => {
      await store.setOutcome(
        values.id ?? '',
        values.agent ?? '',
        {outcome, retryable, detail: values.detail ?? null},
        Date.now()
      );
      await context.log.info('recorded outcome', {
        task: values.id,
        outcome,
        retryable: retryable === null ? '-' : String(retryable),
      });
    });
  },
};

const rm: Command = {
  name: 'rm',
  summary: 'Drop a recorded outcome (e.g. to requeue a surfaced failure).',
  usage: ['dispatch graph outcome rm --id CLC-945', '', STORE_USAGE].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {...STORE_OPTIONS, id: {type: 'string'}},
      allowPositionals: false,
      strict: true,
    });
    assertUsage(
      values.id !== undefined && values.id !== '',
      'outcome rm needs --id'
    );
    await withStore(values, context, async (store) => {
      const existed = await store.removeOutcome(values.id ?? '');
      await context.log.info('removed outcome', {task: values.id, existed});
    });
  },
};

function parseRetryable(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  assert(
    raw === 'true' || raw === 'false',
    new UsageError(`--retryable must be true or false, not "${raw}"`, {
      hint: 'transient cause = --retryable true; structural = --retryable false.',
    })
  );
  return raw === 'true';
}

export const outcome = group({
  name: 'outcome',
  summary: 'Record and clear coordinator outcomes on tasks.',
  children: [set, rm],
});
