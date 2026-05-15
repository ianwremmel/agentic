import { DispatchError, ExitCode } from "./errors.mts";
import { renderCommandHelp, renderTopLevelHelp } from "./help.mts";
import { parseCommandArgs } from "./parser.mts";
import { commands, resolveCommand } from "./registry.mts";

export interface RunOptions {
  argv?: readonly string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  version: string;
}

// Render an error to stderr in the §3.2 format:
//   dispatch: <command>: <message>
// or, when no command was resolved:
//   dispatch: <message>
function emitError(
  stderr: NodeJS.WritableStream,
  message: string,
  command?: string,
): void {
  const prefix = command ? `dispatch: ${command}` : "dispatch";
  stderr.write(`${prefix}: ${message}\n`);
}

export async function run(opts: RunOptions): Promise<number> {
  const argv = opts.argv ?? [];
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const version = opts.version;

  try {
    // Top-level: no args, --version, --help.
    if (argv.length === 0 || argv[0] === "help") {
      stdout.write(renderTopLevelHelp(commands, version));
      return ExitCode.SUCCESS;
    }
    if (argv[0] === "--version" || argv[0] === "-v") {
      stdout.write(`dispatch ${version}\n`);
      return ExitCode.SUCCESS;
    }
    if (argv[0] === "--help" || argv[0] === "-h") {
      stdout.write(renderTopLevelHelp(commands, version));
      return ExitCode.SUCCESS;
    }

    const match = resolveCommand(argv);
    if (!match) {
      emitError(stderr, `unknown command "${argv.join(" ")}"`);
      stderr.write(`Run \`dispatch --help\` to see available commands.\n`);
      return ExitCode.USAGE;
    }
    const { command, rest } = match;

    const { parsed, helpRequested } = parseCommandArgs(command, rest);
    if (helpRequested) {
      stdout.write(renderCommandHelp(command));
      return ExitCode.SUCCESS;
    }

    await command.handler(parsed, { stdout, stderr });
    return ExitCode.SUCCESS;
  } catch (err) {
    if (err instanceof DispatchError) {
      emitError(stderr, err.message, err.command);
      return err.code;
    }
    // Unexpected: format generically. Include the error class for
    // debuggability without leaking a full stack trace to users.
    const msg = err instanceof Error ? err.message : String(err);
    emitError(stderr, `unexpected error: ${msg}`);
    return ExitCode.GENERIC;
  }
}
