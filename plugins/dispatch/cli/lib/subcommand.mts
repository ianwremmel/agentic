import {requestsHelp} from './args.mts';
import type {Command} from './command.mts';
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
}

/**
 * A command that dispatches to subcommands (`dispatch graph ingest ...`).
 *
 * The result is an ordinary {@link Command}, so the registry stays a flat list
 * and a group can nest inside a group without anything downstream knowing.
 */
export function group({name, summary, path, children}: GroupSpec): Command {
  const byName = new Map(children.map((child) => [child.name, child]));
  const width = Math.max(...children.map((child) => child.name.length));

  const usage = [
    `dispatch ${path ?? name} <subcommand> [args...]`,
    '',
    'subcommands:',
    ...children.map(
      (child) => `  ${child.name.padEnd(width)}  ${child.summary}`
    ),
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

      if (
        (subcommand === undefined || subcommand.startsWith('-')) &&
        requestsHelp(argv)
      ) {
        await writeLine(context.stdout, `usage: ${usage}`);
        return;
      }

      ensure(
        subcommand !== undefined && !subcommand.startsWith('-'),
        () => new TaggedUsageError(`${name} needs a subcommand`, {usage})
      );

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

      try {
        await child.run(childArgs, context);
      } catch (error) {
        // The caller got the *subcommand* wrong, so it needs the subcommand's
        // usage. Only the group knows which child ran, so it tags the error here;
        // otherwise the CLI would answer a bad `graph ingest` flag with the list
        // of graph subcommands, which says nothing about the flag.
        if (
          error instanceof UsageError &&
          !(error instanceof TaggedUsageError)
        ) {
          throw new TaggedUsageError(error.message, {
            cause: error,
            usage: child.usage,
            ...(error.hint === undefined ? {} : {hint: error.hint}),
          });
        }
        throw error;
      }
    },
  };
}
