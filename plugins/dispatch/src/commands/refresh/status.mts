import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';

const options = {
  tracker: {
    type: 'string',
    description: 'Tracker to report on.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'status';
  readonly summary =
    'Print the refresh state and every outstanding instruction.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const {refresh, requests} = await new RefreshService(db).status(
        parsed.tracker
      );
      ctx.io.write(`refresh ${parsed.tracker} ${refresh?.state ?? 'none'}\n`);
      for (const request of requests) {
        if (request.resolution !== null) continue;
        ctx.io.write(
          `${request.kind} ${JSON.stringify(request.payload)} delivered=${String(request.deliveredAt !== null)}\n`
        );
      }
    });
  }
}
