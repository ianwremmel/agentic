import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {nowIso} from '../../lib/db/time.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../../lib/graph/index.mts';
import {CoordinationStore} from '../../lib/stores/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'The node whose recorded outcome should be dropped.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'rm';
  readonly summary = 'Drop a recorded outcome, requeueing surfaced work.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const existed = await new CoordinationStore(db).removeOutcome(parsed.id, {
        now: nowIso(),
        staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
      });
      ctx.io.write(`removed outcome ${parsed.id} existed=${String(existed)}\n`);
    });
  }
}
