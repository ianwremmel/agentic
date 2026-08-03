import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {} as const;

export class Command extends AbstractCommand {
  readonly name = 'wrong';
  readonly summary = 'Name does not match the file.';
  readonly env = [];
  readonly options = options;

  async run(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _parsed: ParsedOptions<typeof options>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ctx: CommandContext
    // eslint-disable-next-line @typescript-eslint/no-empty-function
  ): Promise<void> {}
}
