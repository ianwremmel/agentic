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
      // Only what the caller named. A worker keeping the URL and PR number
      // current names nothing else, and must not thereby unlink the item from
      // its ticket or blank its title. An explicit empty string still clears a
      // field — omission is what preserves. `injected` is the exception the
      // parser forces: an absent boolean is indistinguishable from `--no`, so
      // it is carried only when set.
      await new PrStore(db).patchPr({
        id: parsed.id,
        ...(parsed.ticket === undefined
          ? {}
          : {ticket: parsed.ticket === '' ? null : parsed.ticket}),
        ...(parsed.origin === undefined ? {} : {origin: parsed.origin}),
        ...(parsed.repo === undefined ? {} : {repo: parsed.repo}),
        ...(parsed['pr-number'] === undefined
          ? {}
          : {prNumber: parsed['pr-number']}),
        ...(parsed.url === undefined ? {} : {url: parsed.url}),
        ...(parsed.branch === undefined ? {} : {branch: parsed.branch}),
        ...(parsed.title === undefined ? {} : {title: parsed.title}),
        ...(parsed.injected ? {injected: true} : {}),
        ...(parsed.priority === undefined ? {} : {priority: parsed.priority}),
      });
      await new RefreshService(db).reconcile();
      ctx.io.write(`pr ${parsed.id}\n`);
    });
  }
}
