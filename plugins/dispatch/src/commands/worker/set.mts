import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DataError, ensure} from '../../lib/errors/index.mts';
import {correlateSession} from '../../lib/schedule/index.mts';
import {WorkerStore} from '../../lib/stores/index.mts';

const options = {
  node: {
    type: 'string',
    description: 'The node the launched worker is working.',
    positional: false,
    required: true,
  },
  agent: {
    type: 'string',
    description:
      'The agent ref the launch returned — the address a relayed event reaches the worker at.',
    positional: false,
    required: true,
  },
  db: DB_OPTION,
} as const;

/**
 * Record where a node's worker can be reached. The orchestrate session runs
 * this right after a launch, with the ref the launch returned; from then on
 * events for the node carry that ref, and the session relays instead of
 * letting the item cold-start a resume pass.
 *
 * Identity comes from the environment: the row belongs to the launching
 * session, because only the launcher holds a ref that can actually reach the
 * agent.
 */
export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary = "Record a launched worker's address for event routing.";
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const session = await correlateSession(db, ctx.env, undefined);
      ensure(
        session !== null,
        () =>
          new DataError('no live server correlates to this session', {
            hint: 'only the session that launched the worker can record its address.',
          })
      );
      await new WorkerStore(db).set({
        node: parsed.node,
        session,
        agentRef: parsed.agent,
        at: nowIso(),
      });
      ctx.io.write(`worker ${parsed.node} ${parsed.agent}\n`);
    });
  }
}
