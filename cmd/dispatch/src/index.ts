#!/usr/bin/env node
import { daemonStart } from "./commands/daemon-start.js";
import { daemonStatus } from "./commands/daemon-status.js";
import { daemonStop } from "./commands/daemon-stop.js";
import { CliError, UsageError } from "./util/errors.js";

const USAGE = `Usage: dispatch <command> [...args]

Commands:
  daemon start [--foreground]   Start the dispatch daemon
  daemon stop  [--force]        Stop the dispatch daemon
  daemon status                 Show daemon status
  help                          Show this message
`;

type CommandHandler = (argv: string[]) => Promise<number>;

const COMMANDS: Record<string, Record<string, CommandHandler>> = {
  daemon: {
    start: daemonStart,
    stop: daemonStop,
    status: daemonStatus,
  },
};

async function main(rawArgv: string[]): Promise<number> {
  const [group, sub, ...rest] = rawArgv;

  if (!group || group === "help" || group === "--help" || group === "-h") {
    process.stdout.write(USAGE);
    return group ? 0 : 2;
  }

  const subcommands = COMMANDS[group];
  if (!subcommands) throw new UsageError(`unknown command: ${group}`);

  if (!sub) throw new UsageError(`${group}: missing subcommand`);
  const handler = subcommands[sub];
  if (!handler) throw new UsageError(`${group}: unknown subcommand: ${sub}`);

  return handler(rest);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`error: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
