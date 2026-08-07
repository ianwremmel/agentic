import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {OUTCOMES} from '../../lib/model/status.mts';
import {correlateSession} from '../../lib/schedule/index.mts';
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
  force: {
    type: 'boolean',
    description:
      'Record even though no claim is held. For an operator resolving a node by hand; a dispatched worker always holds its claim and never needs this.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary = 'Record a final report on a node, releasing its claim.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      // Identity comes from the environment, never from a flag. An id a
      // caller supplies is an assertion, not evidence, and the holders are
      // printed by `dispatch claim status` — so an unclaimed worker could
      // name one and pass.
      //
      // Holding the claim is what authorizes a report: an outcome is a report
      // from work that was dispatched. The check runs inside the write's own
      // transaction, because a claim read out here can be swept, released, or
      // taken by another session before the write lands.
      //
      // `correlateSession` returning null cannot tell an operator at a
      // terminal from a worker whose server just died, so it is not treated
      // as authority — that would leave the guard bypassable exactly when the
      // system is unhealthy, which is when it matters. An operator resolving
      // a node by hand passes --force and says so.
      const session = await correlateSession(db, ctx.env, undefined);
      await new CoordinationStore(db).recordOutcome(
        {
          node: parsed.id,
          outcome: parsed.outcome,
          // The parser defaults an absent boolean to false; only a failure
          // carries a meaningful retryable, and the store enforces that.
          retryable: parsed.outcome === 'failed' ? parsed.retryable : null,
          detail: parsed.detail ?? null,
          recordedAt: nowIso(),
        },
        {session: session ?? '', requireClaim: !parsed.force}
      );
      ctx.io.write(`outcome ${parsed.id} ${parsed.outcome}\n`);
    });
  }
}
