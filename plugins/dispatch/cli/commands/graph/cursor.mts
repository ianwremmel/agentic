import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage} from '../../lib/errors.mts';
import {writeLine} from '../../lib/io.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * Read or write the opaque per-source sync cursor (§2.6 producer contract).
 *
 * The cursor is whatever the tracker means by "changed since" — a Linear
 * `updatedAt`, a GitHub `since`. `graph ingest` stores the one its payload
 * carries; this is how a producer reads it back to decide between a delta and a
 * full sync, and how it can be reset by hand.
 */
export const cursor: Command = {
  name: 'cursor',
  summary: 'Print the sync cursor for a source, or set it.',
  usage: [
    'dispatch graph cursor [--source <name>] [--set <token>]',
    '',
    'Prints nothing and exits 0 when no cursor is stored — the first-run case,',
    'where the producer does a full sync.',
    '',
    'options:',
    '  --source <name>  Cursor namespace (default: linear).',
    '  --set <token>    Store this cursor instead of printing the stored one.',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        source: {type: 'string'},
        set: {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });

    const source = values.source ?? 'linear';

    await withStore(values, context, async (store) => {
      if (values.set !== undefined) {
        assertUsage(
          values.set !== '',
          'cursor --set needs a token, e.g. --set 2026-07-11T00:00:00.000Z'
        );

        await store.setCursor(source, values.set);
        await context.log.info('stored cursor', {source, cursor: values.set});
        return;
      }

      const stored = await store.getCursor(source);
      // An absent cursor prints nothing and exits 0: the caller reads an empty
      // string and does a full sync, which is exactly the first-run path.
      if (stored !== null) await writeLine(context.stdout, stored);

      await context.log.info('read cursor', {source, cursor: stored ?? '-'});
    });
  },
};
