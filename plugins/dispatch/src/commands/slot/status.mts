import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {DEFAULT_MAX_PARALLEL} from '../../lib/schedule/index.mts';
import {CoordinationStore} from '../../lib/stores/index.mts';

const options = {
  max: {
    type: 'number',
    description: 'Ledger size.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'status';
  readonly summary = 'Report held and free compute slots.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const held = await new CoordinationStore(db).slotCount();
      const max = parsed.max ?? DEFAULT_MAX_PARALLEL;
      ctx.io.write(
        `slots held=${String(held)} free=${String(Math.max(0, max - held))} max=${String(max)}\n`
      );
    });
  }
}
