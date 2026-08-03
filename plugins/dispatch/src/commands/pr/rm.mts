import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {PrStore} from '../../lib/stores/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'Identifier for the PR item.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'rm';
  readonly summary = 'Delete one PR work item.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const existed = await new PrStore(db).removePr(parsed.id);
      await new RefreshService(db).reconcile();
      ctx.io.write(`removed pr ${parsed.id} existed=${String(existed)}\n`);
    });
  }
}
