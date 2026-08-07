import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {DataError, ensure} from '../../lib/errors/index.mts';
import {correlateSession} from '../../lib/schedule/index.mts';
import {WorkerStore} from '../../lib/stores/index.mts';

const options = {
  node: {
    type: 'string',
    description: 'The node whose worker address to drop.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

/**
 * Hand a node from warm relay to cold recovery, for a relay that provably
 * went nowhere: drops the caller's own address and releases its claim, so
 * the scheduler re-serves the item as a `resume` pass.
 */
export class Command extends AbstractCommand {
  readonly name = 'rm';
  readonly summary = "Drop a node's worker address.";
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const session = await correlateSession(db, ctx.env, undefined);
      ensure(
        session !== null,
        () =>
          new DataError('no live server correlates to this session', {
            hint: 'only the session that recorded the address can revoke it.',
          })
      );
      const removed = await new WorkerStore(db).remove(parsed.node, session);
      ctx.io.write(`worker ${parsed.node} removed=${String(removed)}\n`);
    });
  }
}
