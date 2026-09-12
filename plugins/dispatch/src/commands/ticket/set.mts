import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {STATUSES, TARGET_KINDS} from '../../lib/model/status.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {TicketStore} from '../../lib/stores/index.mts';

const options = {
  id: {
    type: 'string',
    description: 'Tracker identifier, e.g. CLC-945.',
    positional: false,
    required: true,
  },
  project: {
    type: 'string',
    description: 'Project the ticket belongs to.',
    positional: false,
    required: true,
  },
  status: {
    type: 'string',
    description: 'Normalized lifecycle status; map the tracker state yourself.',
    positional: false,
    required: true,
    choices: STATUSES,
  },
  title: {
    type: 'string',
    description: 'Ticket title.',
    positional: false,
    required: false,
  },
  url: {
    type: 'string',
    description: 'Ticket URL.',
    positional: false,
    required: false,
  },
  'target-kind': {
    type: 'string',
    description: 'What finishing this ticket produces.',
    positional: false,
    required: false,
    choices: TARGET_KINDS,
  },
  'requires-human': {
    type: 'boolean',
    description: 'Only a human may work this ticket.',
    positional: false,
    required: false,
  },
  injected: {
    type: 'boolean',
    description: 'Rank this ticket to the top of the frontier.',
    positional: false,
    required: false,
  },
  priority: {
    type: 'number',
    description: 'Lower is more urgent; omit if the tracker has none.',
    positional: false,
    required: false,
  },
  labels: {
    type: 'string',
    description: 'Comma-separated tracker labels, passed through as-is.',
    positional: false,
    required: false,
  },
  'branch-hint': {
    type: 'string',
    description: 'Branch-name seed the tracker suggests.',
    positional: false,
    required: false,
  },
  'updated-at': {
    type: 'string',
    description: 'When the tracker last saw the ticket move (RFC 3339).',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary = 'Create or update one ticket.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const labels =
      parsed.labels === undefined
        ? undefined
        : parsed.labels
            .split(',')
            .map((label) => label.trim())
            .filter((label) => label !== '');

    await withDatabase(parsed.db, ctx.env, async (db) => {
      // Only what the caller named. A re-read reports the fields it was asked
      // about and says nothing about the rest, so absent must mean "leave it"
      // — otherwise answering a refresh blanks the ticket's title and labels.
      // `injected` and `requires-human` are carried only when set: the parser
      // cannot tell an absent boolean from a false one.
      await new TicketStore(db).patchTicket({
        id: parsed.id,
        project: parsed.project,
        status: parsed.status,
        ...(parsed.url === undefined ? {} : {url: parsed.url}),
        ...(parsed.title === undefined ? {} : {title: parsed.title}),
        ...(parsed['target-kind'] === undefined
          ? {}
          : {targetKind: parsed['target-kind']}),
        ...(parsed['requires-human'] ? {requiresHuman: true} : {}),
        ...(parsed.injected ? {injected: true} : {}),
        ...(parsed.priority === undefined ? {} : {priority: parsed.priority}),
        ...(parsed['branch-hint'] === undefined
          ? {}
          : {branchHint: parsed['branch-hint']}),
        ...(labels === undefined ? {} : {labels}),
        ...(parsed['updated-at'] === undefined
          ? {}
          : {updatedAt: parsed['updated-at']}),
      });
      await new RefreshService(db).reconcile();
      ctx.io.write(`ticket ${parsed.id}\n`);
    });
  }
}
