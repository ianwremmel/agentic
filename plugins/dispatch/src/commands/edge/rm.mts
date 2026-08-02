import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {EdgeStore} from '../../lib/stores/index.mts';

const options = {
  blocker: {
    type: 'string',
    description: 'The node that must resolve first.',
    positional: false,
    required: true,
  },
  blocked: {
    type: 'string',
    description: 'The node that waits on it.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'rm';
  readonly summary = 'Remove a blocking edge between two nodes.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const existed = await new EdgeStore(db).removeEdge(
        parsed.blocker,
        parsed.blocked
      );
      await new RefreshService(db).reconcile();
      ctx.io.write(
        `removed edge ${parsed.blocker} -> ${parsed.blocked} existed=${String(existed)}\n`
      );
    });
  }
}
