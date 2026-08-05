import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DataError, ensure} from '../../lib/errors/index.mts';
import {WATCH_REASONS} from '../../lib/model/status.mts';
import {resolveSession} from '../../lib/schedule/index.mts';
import {CoordinationStore, PrStore} from '../../lib/stores/index.mts';
import {armWatch, githubFingerprint} from '../../lib/watch/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'The PR item whose wait the server takes over.',
    positional: false,
    required: true,
  },
  for: {
    type: 'string',
    description: 'What the worker is waiting on; sets the poll cadence.',
    positional: false,
    required: true,
    choices: WATCH_REASONS,
  },
  session: {
    type: 'string',
    description:
      'Registry id whose claim and slot the handoff releases; defaults to the session correlated from the environment.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

/**
 * The worker's wait handoff: instead of polling the PR in-band, the worker
 * records what it is waiting on and returns. The watch is armed with the
 * PR's fingerprint as of now, so a change that already landed still fires;
 * recording releases the caller's claim and slot — never another session's —
 * and the server re-queues the item as a `resume` pass when the PR changes.
 */
export class Command extends AbstractCommand {
  readonly name = 'watch';
  readonly summary =
    'Hand a PR wait to the server, releasing the claim and slot.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const pr = await new PrStore(db).getPr(parsed.id);
      ensure(
        pr !== null,
        () =>
          new DataError(`no PR item "${parsed.id}" to watch`, {
            hint: 'register the item with `dispatch pr set` first.',
          })
      );
      ensure(
        pr.repo !== null && pr.prNumber !== null,
        () =>
          new DataError(`PR item "${parsed.id}" has no PR to poll`, {
            hint: 'record it with `dispatch pr set --repo <owner>/<name> --pr-number <n>` once the PR exists, then watch.',
          })
      );

      const coordination = new CoordinationStore(db);
      ensure(
        (await coordination.getOutcome(parsed.id)) === null,
        () =>
          new DataError(`PR item "${parsed.id}" already has an outcome`, {
            hint: 'a concluded item is not waiting; remove the outcome first if it must re-run.',
          })
      );

      const caller = await resolveSession(db, ctx.env, parsed.session);

      await armWatch(db, {
        node: parsed.id,
        reason: parsed.for,
        repo: pr.repo,
        prNumber: pr.prNumber,
        at: nowIso(),
        fingerprint: githubFingerprint,
        log: ctx.log,
      });

      // The wait holds no budget — but only the caller's own holdings go
      // with the handoff. A claim another session took (this worker's went
      // stale and the item was re-dispatched) is that worker's to release.
      await coordination.release(parsed.id, caller);
      await coordination.releaseSlot(caller, parsed.id);

      ctx.io.write(`watch ${parsed.id} ${parsed.for}\n`);
    });
  }
}
