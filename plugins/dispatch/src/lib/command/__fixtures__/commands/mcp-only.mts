import {AbstractCommand} from '../../index.mts';
import type {ParsedOptions, CommandContext} from '../../index.mts';

const options = {} as const;

export class Command extends AbstractCommand {
  readonly name = 'mcp-only';
  readonly summary = 'Reachable over MCP only.';
  readonly env = [];
  readonly options = options;
  override readonly transports = {cli: false};

  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    _parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    ctx.io.write('mcp-only ran\n');
  }
}
