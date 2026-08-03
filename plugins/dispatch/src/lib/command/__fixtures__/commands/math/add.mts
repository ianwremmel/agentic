import {AbstractCommand} from '../../../index.mts';
import type {ParsedOptions, CommandContext} from '../../../index.mts';

const options = {
  a: {
    type: 'number',
    description: 'First addend.',
    positional: false,
    required: true,
  },
  b: {
    type: 'number',
    description: 'Second addend.',
    positional: false,
    required: true,
  },
} as const;

export class Command extends AbstractCommand {
  readonly name = 'add';
  readonly summary = 'Add two numbers.';
  readonly env = [];
  readonly options = options;

  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    ctx.io.write(`${String(parsed.a + parsed.b)}\n`);
  }
}
