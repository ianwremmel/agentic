import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {MilestoneStore} from '../../lib/stores/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'Tracker identifier for the milestone.',
    positional: false,
    required: true,
  },
  project: {
    type: 'string',
    description: 'Project the milestone belongs to.',
    positional: false,
    required: true,
  },
  name: {
    type: 'string',
    description: 'Human-readable milestone name.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary = 'Create or update one milestone.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new MilestoneStore(db).upsertMilestone({
        id: parsed.id,
        project: parsed.project,
        name: parsed.name,
      });
      await new RefreshService(db).reconcile();
      ctx.io.write(`milestone ${parsed.id}\n`);
    });
  }
}
