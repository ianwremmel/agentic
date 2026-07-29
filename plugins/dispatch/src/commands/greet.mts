import {AbstractCommand} from '../lib/command/index.mts';
import type {ParsedOptions, CommandContext} from '../lib/command/index.mts';

const options = {
  who: {
    type: 'string',
    description: 'Who to greet.',
    positional: true,
    required: false,
    default: 'world',
  },
  loud: {
    type: 'boolean',
    description: 'Shout the greeting.',
    positional: false,
    required: false,
  },
} as const;

export class Command extends AbstractCommand {
  readonly name = 'greet';
  readonly summary = 'Print a friendly greeting.';
  readonly env = [];
  readonly options = options;

  run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const message = `hello ${parsed.who}`;
    ctx.log.info(parsed.loud ? message.toUpperCase() : message);
    return Promise.resolve();
  }
}
