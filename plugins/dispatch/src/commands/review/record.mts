import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {ReviewStore} from '../../lib/stores/index.mts';

const options = {
  milestone: {
    type: 'string',
    description: 'The milestone whose review just ran.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'record';
  readonly summary =
    'Record a milestone review with a member snapshot, opening its gate.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new ReviewStore(db).record(parsed.milestone, nowIso());
      await new RefreshService(db).reconcile();
      ctx.io.write(`review ${parsed.milestone}\n`);
    });
  }
}
