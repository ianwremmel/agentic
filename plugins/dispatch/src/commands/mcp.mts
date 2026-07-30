import {AbstractCommand, discover} from '../lib/command/index.mts';
import type {ParsedOptions, CommandContext} from '../lib/command/index.mts';
import {runMcpServer} from '../lib/mcp/index.mts';

const options = {} as const;

export class Command extends AbstractCommand {
  readonly name = 'mcp';
  readonly summary = 'Start the MCP server on stdio.';
  readonly env = [];
  readonly options = options;
  override readonly transports = {mcp: false};

  async run(
    _parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const tree = await discover(new URL('./', import.meta.url));
    await runMcpServer({
      tree,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: ctx.env,
    });
  }
}
