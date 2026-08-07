import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DataError, ensure} from '../../lib/errors/index.mts';
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
  session: {
    type: 'string',
    description:
      'Registry id whose claim this report releases; defaults to the session correlated from the environment.',
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
      // The reporter releases its *own* claim, never whoever holds the node
      // now. A worker whose session was swept mid-run can report late, by
      // which time the node may have been re-dispatched to a live worker;
      // releasing that claim would revoke a running agent's compute grant.
      // Ambiguous correlation refuses: silently releasing nothing there would
      // strand the claim and its capacity.
      const session = await correlateSession(db, ctx.env, parsed.session);
      const coordination = new CoordinationStore(db);

      // An outcome is a report from work that was dispatched. A worker
      // holding no claim was not dispatched, and letting it report is how a
      // ticket disappears: a self-directed worker that the claim guard turned
      // away recorded `failed`, which is non-retryable, so the ticket left
      // the queue for good and nothing re-served it.
      //
      // Refusing costs nothing by comparison. The node keeps whatever state
      // it had and is dispatched again; that is recoverable, and a wrongly
      // recorded terminal outcome is not.
      //
      // A caller with no live server at all is an operator at a terminal,
      // who has no claim by construction and is the one party entitled to
      // record an outcome by hand.
      if (session !== null) {
        const held = (await coordination.claims()).find(
          (claim) => claim.node === parsed.id
        );
        ensure(
          held?.session === session,
          () =>
            new DataError(
              `this session holds no claim on "${parsed.id}", so it cannot report an outcome for it`,
              {
                hint: 'you were not dispatched for this node, or your claim was already released. Stop without reporting; the node stays dispatchable and the scheduler will serve it again.',
              }
            )
        );
      }

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
        {session: session ?? ''}
      );
      ctx.io.write(`outcome ${parsed.id} ${parsed.outcome}\n`);
    });
  }
}
