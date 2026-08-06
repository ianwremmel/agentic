import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DataError, ensure} from '../../lib/errors/index.mts';
import {correlateSession} from '../../lib/schedule/index.mts';
import {CoordinationStore, PrStore} from '../../lib/stores/index.mts';
import {armWatch, githubSnapshot} from '../../lib/watch/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'The PR item this worker is handing back.',
    positional: false,
    required: true,
  },
  session: {
    type: 'string',
    description:
      'Registry id whose claim the handoff releases; defaults to the session correlated from the environment.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

/**
 * Yield an item back to the server: the worker is no longer working on it.
 *
 * Deliberately says nothing about what the worker is waiting for. A worker
 * may be waiting on several things at once, and whatever it declared would go
 * stale the moment the PR moved; the server reads the PR's own state and
 * derives both what changed and how often to look.
 *
 * What the server cannot infer is this call itself. A worker that finished
 * its turn and one that was killed leave the same row — a claim that goes
 * stale — so without an explicit yield the server cannot tell a graceful
 * handoff from a crash, and would have to choose between never resuming a
 * crashed run and re-dispatching a healthy one forever.
 *
 * Releasing the claim gives back the compute grant, so the wait costs nothing
 * while it lasts.
 */
export class Command extends AbstractCommand {
  readonly name = 'yield';
  readonly summary = 'Hand a PR item back to the server, releasing the claim.';
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

      const caller = await correlateSession(db, ctx.env, parsed.session);

      // Release before arming, and refuse the handoff if the claim does not
      // actually go. A watching item is never queued, so a watch armed over
      // a claim still held would consume capacity that nothing can ever
      // reclaim — the item reads as waiting and as in flight at once.
      const released =
        caller === null
          ? 'absent'
          : await coordination.release(parsed.id, caller);
      ensure(
        released === 'released' || released === 'absent',
        () =>
          new DataError(
            `the claim on "${parsed.id}" belongs to another session`,
            {
              hint: 'this worker was superseded; return without arming a watch, and let the session that holds the claim finish.',
            }
          )
      );

      await armWatch(db, {
        node: parsed.id,
        repo: pr.repo,
        prNumber: pr.prNumber,
        at: nowIso(),
        snapshot: githubSnapshot,
        session: caller,
        releaseClaimFor: caller,
        log: ctx.log,
      });

      ctx.io.write(`yield ${parsed.id}\n`);
    });
  }
}
