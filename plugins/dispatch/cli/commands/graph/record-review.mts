import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage, DataError} from '../../lib/errors.mts';
import {DEFAULT_STALE_AFTER_MS} from '../../lib/graph/config.mts';
import {
  deriveOptions,
  STORE_OPTIONS,
  STORE_USAGE,
  withStore,
} from './store-context.mts';

/**
 * Record that a milestone's review ran — the write that opens the
 * milestone-review gate and unblocks the tasks behind it.
 *
 * The record is pinned to the member set it reviewed, so a review that files
 * follow-up tasks into the milestone does not satisfy the gate for the milestone
 * it changed. The review *outcome* is not stored here — it belongs on the
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

    const recordedAtMs =
      values.at === undefined ? Date.now() : Date.parse(values.at);
    assert(
      !Number.isNaN(recordedAtMs),
      new DataError(`--at is not a timestamp: "${values.at ?? ''}"`, {
        hint: 'pass an RFC 3339 instant (e.g. 2026-07-15T12:00:00Z), or omit --at for now.',
      })
    );

    await withStore(values, context, async (store, config) => {
      // Staleness does not affect milestone readiness; any value derives the same
      // milestone states.
      const {members} = await store.recordReview(
        id,
        recordedAtMs,
        deriveOptions(config, DEFAULT_STALE_AFTER_MS)
      );
      await context.log.info('recorded milestone review', {
        milestone: id,
        members,
        recorded_at: new Date(recordedAtMs).toISOString(),
      });
    });
  },
};
