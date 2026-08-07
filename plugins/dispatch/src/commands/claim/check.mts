import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {DataError, ensure} from '../../lib/errors/index.mts';
import {correlateSession} from '../../lib/schedule/index.mts';
import {CoordinationStore} from '../../lib/stores/index.mts';

const options = {
  node: {
    type: 'string',
    description:
      'The ticket, PR item, or milestone this agent was launched for.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

/**
 * Prove that the scheduler actually dispatched this agent, and exit non-zero
 * if it did not.
 *
 * A worker's authority to run comes from a claim: the scheduler takes one
 * before it emits a work order, and the claim is also the admission that
 * bounds how many agents run at once. An agent launched any other way holds
 * no claim, so it spends no budget and nothing caps how many of them there are.
 *
 * That is not hypothetical. A session whose channel went unacknowledged
 * received no work orders, decided on its own what to run, and launched
 * twelve workers against a cap of three — every one of them unclaimed. The
 * skill told it not to. Instructions are not a bound, so this is the bound:
 * a worker asks first and exits when the answer is no, and an unbudgeted
 * launch costs one command instead of an agent.
 */
export class Command extends AbstractCommand {
  readonly name = 'check';
  readonly summary =
    'Verify this session holds a live claim on a node; exit non-zero if not.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      // Deliberately no --session. The whole point is to establish who the
      // caller *is*, and an id it supplies is an assertion, not evidence:
      // `dispatch claim status` prints the holders, so any worker could name
      // one and pass. Correlation from the environment is the only identity
      // the caller does not choose.
      const caller = await correlateSession(db, ctx.env, undefined);
      ensure(
        caller !== null,
        () =>
          new DataError(
            `no live server correlates to this session, so nothing can hold a claim on "${parsed.node}"`,
            {
              hint: 'you were not dispatched by a scheduler — or the one that dispatched you has died, and its claim is about to be swept. Stop, and report that work was launched without a work order.',
            }
          )
      );

      const held = (await new CoordinationStore(db).claims()).find(
        (claim) => claim.node === parsed.node
      );
      ensure(
        held !== undefined,
        () =>
          new DataError(`no claim is held on "${parsed.node}"`, {
            hint: 'you were not dispatched for this node. Stop without doing any work; a worker runs only on a claim the scheduler took for it.',
          })
      );
      ensure(
        held.session === caller,
        () =>
          new DataError(
            `the claim on "${parsed.node}" belongs to ${held.session}, not this session`,
            {
              hint: 'another session is working this node. Stop; two workers on one node undo each other.',
            }
          )
      );

      ctx.io.write(`claim ${parsed.node} ${caller}\n`);
    });
  }
}
