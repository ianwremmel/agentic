import type {Writable} from 'node:stream';

import type {Logger} from './log/logger.mts';

/** What a command is handed at run time. Streams are injected so commands stay callable outside a process. */
export interface CommandContext {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly log: Logger;
  readonly env: NodeJS.ProcessEnv;
}

export interface Command {
  readonly name: string;
  /** One line, shown in `dispatch --help`. */
  readonly summary: string;
  /** Invocation form(s), shown when the command is used wrong. */
  readonly usage: string;
  /**
   * Run the command. `argv` is everything after the command name, unparsed.
   * Throw `UsageError` for bad input; any other throw is a bug and exits 1.
   */
  run(argv: string[], context: CommandContext): Promise<void>;
}
