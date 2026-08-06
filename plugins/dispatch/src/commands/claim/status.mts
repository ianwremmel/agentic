import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../../lib/graph/index.mts';
import {CoordinationStore} from '../../lib/stores/index.mts';

const options = {
  db: DB_OPTION,
} as const;

/**
 * How many claims are live right now, and on what.
 *
 * The count is what an outside supervisor needs to answer "is this session
 * holding work" — a question it cannot get from `dispatch status`, whose
 * `in-flight` counts items classified in-flight (a started ticket, a watched
 * PR) rather than agents currently running.
 */
export class Command extends AbstractCommand {
  readonly name = 'status';
  readonly summary = 'Report the live claims and what holds them.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const coordination = new CoordinationStore(db);
      const now = nowIso();
      const held = await coordination.inFlightCount({
        now,
        staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
      });
      ctx.io.write(`claims held=${String(held)}\n`);
      // Only the claims the count includes. Listing every row while counting
      // the live ones reports two different truths in one output — a stale
      // claim would print as if held and contradict the header a consumer
      // parses.
      for (const claim of await coordination.liveClaims({
        now,
        staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
      })) {
        ctx.io.write(`claim ${claim.node} session=${claim.session}\n`);
      }
    });
  }
}
