import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';

const options = {
  tracker: {
    type: 'string',
    description: 'Tracker whose scan is complete.',
    positional: false,
    required: true,
  },
  cursor: {
    type: 'string',
    description:
      'Opaque tracker token marking how far this scan read. Recorded only when the refresh closes.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'done';
  readonly summary = 'Report that everything the scan found has been written.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const {state, pending} = await new RefreshService(db).completeScan({
        source: parsed.tracker,
        cursor: parsed.cursor ?? null,
      });
      ctx.io.write(`refresh ${parsed.tracker} ${state}\n`);
      for (const id of pending) ctx.io.write(`pending ${id}\n`);
    });
  }
}
