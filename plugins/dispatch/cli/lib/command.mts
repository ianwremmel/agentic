import type {Writable} from 'node:stream';

import type {Logger} from './log/logger.mts';

/** What a command is handed at run time. Streams are injected so commands stay callable outside a process. */
export interface CommandContext {
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** Payload input, for the commands that take one (`graph ingest`). */
  readonly stdin: NodeJS.ReadableStream;
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
   * The command answers `--help` itself, and the CLI must hand the flag over
   * rather than printing {@link usage} on its behalf. Set by command groups: for
   * `dispatch graph ingest --help`, only the group knows the caller is asking
   * about `ingest`.
   */
  readonly handlesHelp?: boolean;
  /**
   * Run the command. `argv` is everything after the command name, unparsed.
   * Throw `UsageError` for bad input; any other throw is a bug and exits 1.
   */
  run(argv: string[], context: CommandContext): Promise<void>;
}
