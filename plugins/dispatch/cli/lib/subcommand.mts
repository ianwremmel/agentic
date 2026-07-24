import {requestsHelp} from './args.mts';
import type {Command, CommandContext} from './command.mts';
import {ensure, TaggedUsageError, UsageError} from './errors.mts';
import {writeLine} from './io.mts';

export interface GroupSpec {
  readonly name: string;
  readonly summary: string;
  /**
   * How the group is invoked, when that is not just its name — a nested group
   * (`graph exclude`) must print the path the caller actually types.
   */
  readonly path?: string;
  readonly children: readonly Command[];
  /**
   * What a bare `dispatch <group>` runs, for a group whose own name is also a
   * command (`dispatch mcp` runs the server; `dispatch mcp status` reports on
   * one). Without one, a bare group is a usage error.
   */
  readonly fallback?: Command;
}

/**
 * A command that dispatches to subcommands (`dispatch graph ingest ...`).
 *
 * The result is an ordinary {@link Command}, so the registry stays a flat list
 * and a group can nest inside a group without anything downstream knowing.
 */
export function group({
  name,
  summary,
  path,
  children,
  fallback,
}: GroupSpec): Command {
  const byName = new Map(children.map((child) => [child.name, child]));
  const width = Math.max(0, ...children.map((child) => child.name.length));

  const usage = [
    fallback === undefined
      ? `dispatch ${path ?? name} <subcommand> [args...]`
      : `dispatch ${path ?? name} [<subcommand> [args...]]`,
    ...(fallback === undefined
      ? []
      : ['', `With no subcommand: ${fallback.summary}`]),
    ...(children.length === 0
      ? []
      : [
          '',
          'subcommands:',
          ...children.map(
            (child) => `  ${child.name.padEnd(width)}  ${child.summary}`
          ),
        ]),
  ].join('\n');

  return {
    name,
    summary,
    usage,
    // `dispatch graph ingest --help` asks for ingest's usage, and only the group
    // knows that. Without this the CLI would answer with the group's own.
    handlesHelp: true,

    async run(argv, context) {
      const subcommand = argv[0];
      const named = subcommand !== undefined && !subcommand.startsWith('-');

      if (!named && requestsHelp(argv)) {
        await writeLine(context.stdout, `usage: ${usage}`);
        return;
      }

      // Nothing named, so either the group runs itself or the caller has to
      // pick a subcommand. The unnamed argv is the fallback's own — its flags.
      if (!named) {
        ensure(
          fallback !== undefined,
          () => new TaggedUsageError(`${name} needs a subcommand`, {usage})
        );
        await runChild(fallback, argv, context);
        return;
      }

      const child = byName.get(subcommand);
      ensure(
        child !== undefined,
        () =>
          new TaggedUsageError(`unknown ${name} subcommand "${subcommand}"`, {
            usage,
          })
      );

      const childArgs = argv.slice(1);
      // A child that handles help itself (a nested group) must route `--help`
      // further — `graph task set --help` wants set's usage, not task's.
      if (requestsHelp(childArgs) && child.handlesHelp !== true) {
        await writeLine(context.stdout, `usage: ${child.usage}`);
        return;
      }

      await runChild(child, childArgs, context);
    },
  };
}

async function runChild(
  child: Command,
  argv: string[],
  context: CommandContext
): Promise<void> {
  try {
    await child.run(argv, context);
  } catch (error) {
    // The caller got the *subcommand* wrong, so it needs the subcommand's
    // usage. Only the group knows which child ran, so it tags the error here;
    // otherwise the CLI would answer a bad `graph ingest` flag with the list
    // of graph subcommands, which says nothing about the flag.
    if (error instanceof UsageError && !(error instanceof TaggedUsageError)) {
      throw new TaggedUsageError(error.message, {
        cause: error,
        usage: child.usage,
        ...(error.hint === undefined ? {} : {hint: error.hint}),
        ...(error.details === undefined ? {} : {details: error.details}),
      });
    }
    throw error;
  }
}
