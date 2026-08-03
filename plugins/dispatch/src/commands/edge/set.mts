import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../../lib/db/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {EdgeStore} from '../../lib/stores/index.mts';

const options = {
  node: {
    type: 'string',
    description: 'The node whose edges are being redeclared.',
    positional: false,
    required: true,
  },
  direction: {
    type: 'string',
    description: 'Which side to replace.',
    positional: false,
    required: true,
    choices: ['blockers', 'blocks'],
  },
  others: {
    type: 'string',
    description: 'Comma-separated node ids; empty clears the direction.',
    positional: false,
    required: false,
    default: '',
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'set';
  readonly summary = 'Replace every edge on one side of a node.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const others = parsed.others
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');

    await withDatabase(parsed.db, ctx.env, async (db) => {
      await new EdgeStore(db).setEdges(parsed.node, parsed.direction, others);
      await new RefreshService(db).reconcile();
      ctx.io.write(
        `edges of ${parsed.node} (${parsed.direction}) = ${others.join(',')}\n`
      );
    });
  }
}
