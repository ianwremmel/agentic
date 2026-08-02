import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {ProjectStore} from '../../lib/stores/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'Tracker identifier for the project.',
    positional: false,
    required: true,
  },
  name: {
    type: 'string',
    description: 'Human-readable project name.',
    positional: false,
    required: true,
  },
  tracker: {
    type: 'string',
    description:
      'Tracker the project lives on, e.g. linear. Every ticket in it inherits this.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary = 'Create or update one project.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: parsed.id,
        name: parsed.name,
        source: parsed.tracker,
      });
      await new RefreshService(db).reconcile();
      ctx.io.write(`project ${parsed.id}\n`);
    });
  }
}
