import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DataError, ensure} from '../../lib/errors/index.mts';
import {SessionStore} from '../../lib/stores/index.mts';

const options = {
  server: {
    type: 'string',
    description: 'Registry id from the probe event being acknowledged.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'ack';
  readonly summary = 'Acknowledge a channel probe, unlocking work orders.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const acked = await new SessionStore(db).ack(
        parsed.server,
        ctx.env.CLAUDE_CODE_SESSION_ID ?? null,
        nowIso()
      );
      ensure(
        acked,
        () =>
          new DataError(`no server registered as "${parsed.server}"`, {
            hint: 'pass the registry id exactly as the probe event carried it.',
          })
      );
      ctx.io.write(`acked ${parsed.server}\n`);
    });
  }
}
