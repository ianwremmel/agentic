import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {correlateSession} from '../../lib/schedule/index.mts';
import {ReviewStore} from '../../lib/stores/index.mts';

const options = {
  milestone: {
    type: 'string',
    description: 'The milestone whose review ended without recording.',
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
  readonly name = 'release';
  readonly summary =
    'Release a milestone-review claim without opening the gate.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      // No server means no claim of this caller's to release; ambiguous
      // correlation refuses rather than leave a real claim held.
      const session =
        (await correlateSession(db, ctx.env, parsed.session)) ?? '';
      const released = await new ReviewStore(db).release(
        parsed.milestone,
        session
      );
      ctx.io.write(
        `released review ${parsed.milestone} existed=${String(released)}\n`
      );
    });
  }
}
