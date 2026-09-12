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
  turn: {
    type: 'string',
    description:
      'The `turn` key of the relayed event whose agent has come back, copied verbatim. Without it nothing says which turn is being reported on and the address is kept.',
    positional: false,
    required: false,
  },
  force: {
    type: 'boolean',
    description:
      'Drop the address whatever the state. For an operator retiring a warm agent by hand; a session reporting an agent return always has the turn, and must not reach for this when a handover is declined.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

/**
 * Hand a node from warm relay to cold recovery: drops the caller's own
 * address and releases its claim, so the scheduler re-serves the item as a
 * `resume` pass. Only the turn named by `--turn` is removable, which is what
 * makes it safe to run every time a relayed agent comes back. `--force` skips
 * that condition.
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
      const outcome = await new WorkerStore(db).remove(parsed.node, session, {
        turn: parsed.turn,
        force: parsed.force,
      });
      ctx.io.write(
        outcome === 'removed'
          ? `worker ${parsed.node} removed=true\n`
          : `worker ${parsed.node} removed=false kept=${outcome}\n`
      );
    });
  }
}
