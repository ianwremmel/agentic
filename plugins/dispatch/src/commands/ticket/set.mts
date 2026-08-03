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
    default: '',
  },
  url: {
    type: 'string',
    description: 'Ticket URL.',
    positional: false,
    required: false,
    default: '',
  },
  'target-kind': {
    type: 'string',
    description: 'What finishing this ticket produces.',
    positional: false,
    required: false,
    default: 'pr',
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
    default: '',
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
    const labels = parsed.labels
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label !== '');

    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new TicketStore(db).upsertTicket({
        id: parsed.id,
        project: parsed.project,
        url: parsed.url,
        title: parsed.title,
        status: parsed.status,
        targetKind: parsed['target-kind'],
        requiresHuman: parsed['requires-human'],
        injected: parsed.injected,
        priority: parsed.priority ?? null,
        branchHint: parsed['branch-hint'] ?? null,
        labels,
        updatedAt: parsed['updated-at'] ?? null,
      });
      await new RefreshService(db).reconcile();
      ctx.io.write(`ticket ${parsed.id}\n`);
    });
  }
}
