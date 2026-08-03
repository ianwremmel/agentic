import {AbstractCommand} from '../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../lib/db/index.mts';
import {dispatchQueue} from '../lib/graph/index.mts';

const options = {
  project: {
    type: 'string',
    description: 'Restrict the queue to one project id.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'queue';
  readonly summary =
    'Print what the scheduler would hand out next, in dispatch order.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const entries = await dispatchQueue(db, {project: parsed.project});
      for (const {entry, pass} of entries) {
        ctx.io.write(
          `${pass ?? 'available'} ${entry.item.id} kind=${entry.item.kind}` +
            (entry.item.project === null
              ? ''
              : ` project=${entry.item.project}`) +
            `${entry.item.injected ? ' injected' : ''}\n`
        );
      }
      if (entries.length === 0) ctx.io.write('queue empty\n');
    });
  }
}
