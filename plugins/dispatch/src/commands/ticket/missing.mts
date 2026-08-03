import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'The ticket id the tracker has no record of.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'missing';
  readonly summary = 'Report that a requested ticket does not exist.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new RefreshService(db).markMissing(parsed.id);
      ctx.io.write(`missing ticket ${parsed.id}\n`);
    });
  }
}
