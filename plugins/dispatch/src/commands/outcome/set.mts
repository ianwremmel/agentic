import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {OUTCOMES} from '../../lib/model/status.mts';
import {CoordinationStore} from '../../lib/stores/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'The node (ticket or PR item) this outcome reports on.',
    positional: false,
    required: true,
  },
  outcome: {
    type: 'string',
    description: 'The final report.',
    positional: false,
    required: true,
    choices: OUTCOMES,
  },
  retryable: {
    type: 'boolean',
    description: 'A failed run worth re-dispatching (failed only).',
    positional: false,
    required: false,
  },
  detail: {
    type: 'string',
    description: 'One line of context for whoever reads the report.',
    positional: false,
    required: false,
  },
  actor: {
    type: 'string',
    description: 'Actor whose compute slot releases with this report.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary =
    'Record a final report on a node, releasing its claim and slot.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const coordination = new CoordinationStore(db);
      const holder = (await coordination.claims()).find(
        (claim) => claim.node === parsed.id
      );
      // A claim can be gone (swept with its session) while the actor's slot
      // survives; the slot's own session keeps the release from being a no-op.
      const session =
        holder?.session ??
        (parsed.actor === undefined
          ? null
          : await coordination.slotHolder(parsed.actor));
      await coordination.recordOutcome(
        {
          node: parsed.id,
          outcome: parsed.outcome,
          // The parser defaults an absent boolean to false; only a failure
          // carries a meaningful retryable, and the store enforces that.
          retryable: parsed.outcome === 'failed' ? parsed.retryable : null,
          detail: parsed.detail ?? null,
          recordedAt: nowIso(),
        },
        {
          session: session ?? '',
          ...(parsed.actor === undefined || session === null
            ? {}
            : {actor: parsed.actor}),
        }
      );
      ctx.io.write(`outcome ${parsed.id} ${parsed.outcome}\n`);
    });
  }
}
