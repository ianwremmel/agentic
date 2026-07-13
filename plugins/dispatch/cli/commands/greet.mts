import {parseArgsOrUsage} from '../args.mts';
import type {Command} from '../command.mts';
import {assertUsage} from '../errors.mts';
import {writeLine} from '../io.mts';

/** Print `hello <name>` to stdout. The name comes from `--name` or a lone positional. */
export const greet: Command = {
  name: 'greet',
  summary: 'Print a greeting to stdout.',
  usage: 'dispatch greet <name>\n       dispatch greet --name <name>',

  async run(argv, {stdout, log}) {
    const {values, positionals} = parseArgsOrUsage({
      args: argv,
      options: {name: {type: 'string', short: 'n'}},
      allowPositionals: true,
      strict: true,
    });

    assertUsage(
      positionals.length <= 1,
      `greet takes at most one name, got ${String(positionals.length)}: ${positionals.join(', ')}`
    );

    const name = values.name ?? positionals[0];
    assertUsage(name !== undefined && name !== '', 'greet requires a name');

    await log.debug('resolved greeting target', {
      name,
      source: values.name === undefined ? 'positional' : 'flag',
    });

    await writeLine(stdout, `hello ${name}`);

    await log.info('greeted', {name});
  },
};
