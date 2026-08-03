import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {} as const;

export class Command extends AbstractCommand {
  readonly name = 'cli-only';
  readonly summary = 'Reachable over cli only.';
  readonly env = [];
  readonly options = options;
  override readonly transports = {mcp: false};

  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    _parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    ctx.io.write('cli-only ran\n');
  }
}
