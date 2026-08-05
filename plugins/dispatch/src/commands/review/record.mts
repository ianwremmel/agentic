import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {resolveSession} from '../../lib/schedule/index.mts';
import {ReviewStore} from '../../lib/stores/index.mts';

const options = {
  milestone: {
    type: 'string',
    description: 'The milestone whose review just ran.',
    positional: false,
    required: true,
  },
  session: {
    type: 'string',
    description:
      'Registry id whose claim this releases; defaults to the session correlated from the environment.',
    positional: false,
    required: false,
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
      const session = await resolveSession(db, ctx.env, parsed.session).catch(
        () => ''
      );
      await new ReviewStore(db).record(parsed.milestone, nowIso(), session);
      await new RefreshService(db).reconcile();
      ctx.io.write(`review ${parsed.milestone}\n`);
    });
  }
}
