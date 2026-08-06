import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DataError, ensure} from '../../lib/errors/index.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../../lib/graph/index.mts';
import {correlateSession} from '../../lib/schedule/index.mts';
import {CoordinationStore, SessionStore} from '../../lib/stores/index.mts';

const options = {
  node: {
    type: 'string',
    description:
      'The ticket, PR item, or milestone this agent was launched for.',
    positional: false,
    required: true,
  },
  session: {
    type: 'string',
    description:
      'Registry id expected to hold the claim; defaults to the session correlated from the environment.',
    positional: false,
    required: false,
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
      const caller = await correlateSession(db, ctx.env, parsed.session);
      ensure(
        caller !== null,
        () =>
          new DataError(
            `no live server correlates to this session, so nothing can hold a claim on "${parsed.node}"`,
            {
              hint: 'you were not dispatched by a scheduler. Stop, and report to the operator that work was launched without a work order.',
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

      // A claim under a session that stopped heartbeating is nobody's
      // obligation — the sweep will cascade it — so it is not authority.
      const session = await new SessionStore(db).getSession(caller);
      const now = Date.parse(nowIso());
      ensure(
        session !== null &&
          now - Date.parse(session.heartbeatAt) <=
            DEFAULT_STALE_AFTER_SECONDS * 1_000,
        () =>
          new DataError(
            `the session holding "${parsed.node}" is no longer heartbeating`,
            {
              hint: 'its server died; the claim is about to be swept and the node re-dispatched. Stop and let the replacement run.',
            }
          )
      );

      ctx.io.write(`claim ${parsed.node} ${caller}\n`);
    });
  }
}
