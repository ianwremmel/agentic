import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {
  who: {
    type: 'string',
    description: 'Who to greet.',
    positional: true,
    required: false,
    default: 'world',
  },
  format: {
    type: 'string',
    description: 'Output shape.',
    positional: false,
    required: false,
    default: 'text',
    choices: ['text', 'json'],
  },
} as const;

export class Command extends AbstractCommand {
  readonly name = 'greet';
  readonly summary = 'Print a greeting.';
  readonly env = [];
  readonly options = options;

  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    if (parsed.format === 'json') {
      ctx.io.write(`${JSON.stringify({hello: parsed.who})}\n`);
    } else {
      ctx.io.write(`hello ${parsed.who}\n`);
    }
  }
}
