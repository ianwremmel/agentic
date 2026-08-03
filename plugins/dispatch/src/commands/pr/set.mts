import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {PR_ORIGINS} from '../../lib/model/status.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {PrStore} from '../../lib/stores/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'Identifier for the PR item, e.g. owner/repo#7.',
    positional: false,
    required: true,
  },
  ticket: {
    type: 'string',
    description: 'The originating ticket; omit for a bare PR or prompt item.',
    positional: false,
    required: false,
  },
  origin: {
    type: 'string',
    description: 'How the item entered the graph.',
    positional: false,
    required: false,
    default: 'prompt',
    choices: PR_ORIGINS,
  },
  repo: {
    type: 'string',
    description: 'Repository as owner/repo.',
    positional: false,
    required: false,
  },
  'pr-number': {
    type: 'number',
    description: 'Pull request number, once one exists.',
    positional: false,
    required: false,
  },
  url: {
    type: 'string',
    description: 'Pull request URL.',
    positional: false,
    required: false,
  },
  branch: {
    type: 'string',
    description: 'Head branch.',
    positional: false,
    required: false,
  },
  title: {
    type: 'string',
    description: 'One-line description of the work.',
    positional: false,
    required: false,
    default: '',
  },
  injected: {
    type: 'boolean',
    description: 'Rank this item to the top of the frontier.',
    positional: false,
    required: false,
  },
  priority: {
    type: 'number',
    description: 'Lower is more urgent.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary = 'Create or update one PR work item.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new PrStore(db).upsertPr({
        id: parsed.id,
        ticket: parsed.ticket ?? null,
        origin: parsed.origin,
        repo: parsed.repo ?? null,
        prNumber: parsed['pr-number'] ?? null,
        url: parsed.url ?? null,
        branch: parsed.branch ?? null,
        title: parsed.title,
        injected: parsed.injected,
        priority: parsed.priority ?? null,
        updatedAt: null,
      });
      await new RefreshService(db).reconcile();
      ctx.io.write(`pr ${parsed.id}\n`);
    });
  }
}
