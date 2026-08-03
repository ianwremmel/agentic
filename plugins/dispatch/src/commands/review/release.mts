import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {ReviewStore} from '../../lib/stores/index.mts';

const options = {
  milestone: {
    type: 'string',
    description: 'The milestone whose review ended without recording.',
    positional: false,
    required: true,
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
      const released = await new ReviewStore(db).release(parsed.milestone);
      ctx.io.write(
        `released review ${parsed.milestone} existed=${String(released)}\n`
      );
    });
  }
}
