import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {resolveSession} from '../../lib/schedule/index.mts';
import {CoordinationStore} from '../../lib/stores/index.mts';

const options = {
  actor: {
    type: 'string',
    description: 'The actor whose slot returns to the ledger.',
    positional: false,
    required: true,
  },
  session: {
    type: 'string',
    description:
      'Registry id owning the slot; defaults to the session correlated from the environment.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'release';
  readonly summary = 'Give a compute slot back for any wait or exit.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const session = await resolveSession(db, ctx.env, parsed.session);
      const released = await new CoordinationStore(db).releaseSlot(
        session,
        parsed.actor
      );
      ctx.io.write(
        `released slot ${parsed.actor} existed=${String(released)}\n`
      );
    });
  }
}
