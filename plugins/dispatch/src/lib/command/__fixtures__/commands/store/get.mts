import {AbstractCommand} from '../../../index.mts';
import type {ParsedOptions, CommandContext} from '../../../index.mts';

const options = {
  key: {
    type: 'string',
    description: 'Key to read.',
    positional: true,
    required: true,
  },
} as const;

export class Command extends AbstractCommand {
  readonly name = 'get';
  readonly summary = 'Read one key.';
  readonly env = [];
  readonly options = options;

  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    ctx.io.write(`get ${parsed.key}\n`);
  }
}
