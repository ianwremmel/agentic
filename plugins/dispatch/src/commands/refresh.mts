import {AbstractCommand} from '../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../lib/db/index.mts';
import {RefreshService} from '../lib/refresh/index.mts';

const options = {
  tracker: {
    type: 'string',
    description: 'Tracker to refresh, e.g. linear.',
    positional: false,
    required: true,
  },
  project: {
    type: 'string',
    description: 'Comma-separated project ids to scan.',
    positional: false,
    required: true,
  },
  rebuild: {
    type: 'boolean',
    description: 'Drop the graph and scan from scratch, ignoring the cursor.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'refresh';
  readonly summary =
    'Start or resume building the project graph for a tracker.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const projects = parsed.project
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');

    await withDatabase(parsed.db, ctx.env, async (db) => {
      const {resumed} = await new RefreshService(db).startScan({
        source: parsed.tracker,
        projects,
        sessionId: ctx.env.CLAUDE_CODE_SESSION_ID ?? null,
        rebuild: parsed.rebuild,
      });
      ctx.io.write(
        `refresh ${parsed.tracker} ${resumed ? 'resumed' : 'opened'}\n`
      );
    });
  }
}
