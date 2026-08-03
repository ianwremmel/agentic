import type {AbstractCommand, Io} from '../command/index.mts';
import {parseOptions, assertEnv} from '../command/index.mts';
import type {Logger} from '../logger/index.mts';
import {DispatchError} from '../errors/index.mts';

export interface ToolResult {
  readonly content: readonly {readonly type: 'text'; readonly text: string}[];
  readonly isError?: boolean;
}

export interface CallToolContext {
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
}

/**
 * Run one command from JSON tool input. Output written to `io` becomes the
 * result text; a `DispatchError` (bad input, missing env) becomes an `isError`
 * result rather than throwing, mirroring how the cli maps it to an exit code.
 */
export async function callTool(
  command: AbstractCommand,
  args: Readonly<Record<string, unknown>>,
  ctx: CallToolContext
): Promise<ToolResult> {
  let captured = '';
  const io: Io = {
    write: (chunk) => {
      captured += chunk;
    },
  };

  try {
    const raw: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      raw[key] =
        typeof value === 'boolean'
          ? value
          : typeof value === 'number' || typeof value === 'string'
            ? String(value)
            : JSON.stringify(value);
    }
    const parsed = parseOptions(command.options, raw);
    assertEnv(command.env, ctx.env);
    await command.run(parsed, {log: ctx.log, env: ctx.env, io});
    return {content: [{type: 'text', text: captured}]};
  } catch (error) {
    const text =
      error instanceof DispatchError ? error.toString() : String(error);
    return {content: [{type: 'text', text}], isError: true};
  }
}
