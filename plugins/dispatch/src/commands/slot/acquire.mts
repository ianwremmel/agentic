import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DataError, ensure} from '../../lib/errors/index.mts';
import {
  DEFAULT_MAX_PARALLEL,
  resolveSession,
} from '../../lib/schedule/index.mts';
import {CoordinationStore} from '../../lib/stores/index.mts';

const options = {
  actor: {
    type: 'string',
    description:
      'The id of the node being worked (the PR item, ticket, or milestone). The scheduler counts a claim and its slot as one obligation only when they name the same node.',
    positional: false,
    required: true,
  },
  session: {
    type: 'string',
    description:
      'Registry id owning the slot; defaults to the session correlated from the environment.',
    positional: false,
    required: false,
  },
  max: {
    type: 'number',
    description: 'Ledger size.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'acquire';
  readonly summary =
    'Take a compute slot before writing code or running builds.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const session = await resolveSession(db, ctx.env, parsed.session);
      const result = await new CoordinationStore(db).acquireSlot({
        session,
        actor: parsed.actor,
        max: parsed.max ?? DEFAULT_MAX_PARALLEL,
        acquiredAt: nowIso(),
      });
      ensure(
        result !== 'full',
        () =>
          new DataError('the compute ledger is full', {
            hint: 'every slot is held; wait and retry before computing.',
          })
      );
      ctx.io.write(`slot ${result} ${parsed.actor}\n`);
    });
  }
}
