import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage, DataError} from '../../lib/errors.mts';
import {derive} from '../../lib/graph/derive.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * Record that a milestone's §2.3 review has run — the write that opens the §2.6
 * milestone-review gate and unblocks the tickets behind it.
 *
 * The record is pinned to the member set it reviewed, so a review that files
 * follow-up tickets into the milestone does not satisfy the gate for the
 * milestone it just changed: those tickets re-open it, and the next completion
 * needs a fresh review.
 *
 * The review *outcome* is not stored here. §2.3 puts it on the tracker's review
 * artifact, which is where a human reads it; this only records that it happened.
 */
export const recordReview: Command = {
  name: 'record-review',
  summary: 'Record that a milestone review ran, opening its gate.',
  usage: [
    'dispatch graph record-review <milestone-id>',
    '',
    'Fails unless the milestone is ready for review: recording a review of a',
    'milestone that still has open work would open the gate on unfinished work.',
    '',
    'options:',
    '  --at <timestamp>  When the review ran (default: now, RFC 3339).',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values, positionals} = parseArgsOrUsage({
      args: argv,
      options: {...STORE_OPTIONS, at: {type: 'string'}},
      allowPositionals: true,
      strict: true,
    });

    const id = positionals[0];
    assertUsage(
      id !== undefined && positionals.length === 1,
      'record-review takes exactly one milestone id'
    );

    const recordedAt = values.at ?? new Date().toISOString();

    await withStore(values, context, async (store, config) => {
      const graph = derive(await store.snapshot(), {
        parkedRoles: config.parkedRoles,
      });

      const milestone = graph.milestones.find((entry) => entry.id === id);
      assert(
        milestone !== undefined,
        new DataError(`no milestone "${id}" in the graph`, {
          hint:
            graph.milestones.length === 0
              ? 'the graph holds no milestones — ingest a payload whose "milestones" array carries them.'
              : `known milestones: ${graph.milestones.map((entry) => entry.id).join(', ')}.`,
        })
      );

      assert(
        milestone.readyForReview,
        new DataError(
          `milestone "${id}" is not ready for review: ${String(milestone.openCount)} of ${String(milestone.memberCount)} tickets are still open`,
          {
            hint: 'a milestone is ready only when every ticket in it is verified or canceled and none of their dependencies is unresolved (§2.3). Finish the milestone, then record the review.',
          }
        )
      );

      await store.recordReview(id, milestone.fingerprint, recordedAt);

      await context.log.info('recorded milestone review', {
        milestone: id,
        project: milestone.project,
        members: milestone.memberCount,
        fingerprint: milestone.fingerprint,
        recorded_at: recordedAt,
      });
    });
  },
};
