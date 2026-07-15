import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage, DataError} from '../../lib/errors.mts';
import {DEFAULT_STALE_AFTER_MS} from '../../lib/graph/config.mts';
import {
  deriveGraph,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

/**
 * Record that a milestone's §2.3 review ran — the write that opens the §2.6
 * milestone-review gate and unblocks the tasks behind it.
 *
 * The record is pinned to the member set it reviewed, so a review that files
 * follow-up tasks into the milestone does not satisfy the gate for the milestone
 * it changed. The review *outcome* is not stored here — §2.3 puts it on the
 * tracker's review artifact; this only records that it happened.
 */
export const recordReview: Command = {
  name: 'record-review',
  summary: 'Record that a milestone review ran, opening its gate.',
  usage: [
    'dispatch graph record-review --id M1 [--at TS]',
    '',
    'Fails unless the milestone is ready for review: recording a review of a',
    'milestone with open work would open the gate on unfinished work.',
    '',
    'options:',
    '  --id <id>   Milestone id (required).',
    '  --at <ts>   When the review ran (default: now, RFC 3339).',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {...STORE_OPTIONS, id: {type: 'string'}, at: {type: 'string'}},
      allowPositionals: false,
      strict: true,
    });

    const id = values.id;
    assertUsage(id !== undefined && id !== '', 'record-review needs --id');

    const recordedAt = values.at ?? new Date().toISOString();

    await withStore(values, context, async (store, config) => {
      // Staleness does not affect milestone readiness; any value derives the same
      // milestone states.
      const graph = await deriveGraph(store, config, DEFAULT_STALE_AFTER_MS);

      const milestone = graph.milestones.find((entry) => entry.id === id);
      assert(
        milestone !== undefined,
        new DataError(`no milestone "${id}" in the graph`, {
          hint:
            graph.milestones.length === 0
              ? 'the graph holds no milestones — add them with `dispatch graph milestone set`.'
              : `known milestones: ${graph.milestones.map((entry) => entry.id).join(', ')}.`,
        })
      );

      assert(
        milestone.readyForReview,
        new DataError(
          `milestone "${id}" is not ready for review: ${String(milestone.openCount)} of ${String(milestone.memberCount)} tasks are still open`,
          {
            hint: 'a milestone is ready only when every task in it is verified or canceled and none of their dependencies is unresolved.',
          }
        )
      );

      await store.recordReview(id, milestone.fingerprint, recordedAt);
      await context.log.info('recorded milestone review', {
        milestone: id,
        members: milestone.memberCount,
        fingerprint: milestone.fingerprint,
        recorded_at: recordedAt,
      });
    });
  },
};
