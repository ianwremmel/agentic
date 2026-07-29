import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {} as const;

export class Command extends AbstractCommand {
  readonly name = 'needs-token';
  readonly summary = 'Requires MY_TOKEN.';
  readonly env = ['MY_TOKEN'];
  readonly options = options;

  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    _parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    ctx.log.info('ok');
  }
}
