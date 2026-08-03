import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../../lib/graph/index.mts';
import {SessionStore} from '../../lib/stores/index.mts';

const options = {
  server: {
    type: 'string',
    description:
      'Answer for one registry id instead of correlating by session.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'status';
  readonly summary =
    'Report whether this session has an acknowledged channel server.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const sessions = new SessionStore(db);
      const now = nowIso();
      const caller = ctx.env.CLAUDE_CODE_SESSION_ID ?? null;

      // Fail closed: a wrong `active` strands a session yielding for events
      // that never arrive; a wrong `inactive` costs only polling.
      if (parsed.server !== undefined) {
        const named = await sessions.getSession(parsed.server);
        if (
          named === null ||
          (caller !== null && named.claudeSessionId !== caller)
        ) {
          ctx.io.write('inactive no-server-for-session\n');
          return;
        }
        ctx.io.write(
          named.ackedAt === null
            ? 'inactive awaiting-ack\n'
            : `active ${named.id}\n`
        );
        return;
      }

      if (caller === null) {
        ctx.io.write('inactive no-session-id\n');
        return;
      }
      const live = await sessions.liveForCaller(
        caller,
        now,
        DEFAULT_STALE_AFTER_SECONDS
      );
      if (live.length === 0) {
        ctx.io.write('inactive no-server-for-session\n');
        return;
      }
      if (live.length > 1) {
        ctx.io.write('inactive ambiguous-session\n');
        return;
      }
      const only = live[0];
      ctx.io.write(
        only?.ackedAt == null
          ? 'inactive awaiting-ack\n'
          : `active ${only.id}\n`
      );
    });
  }
}
