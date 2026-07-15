import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage} from '../../lib/errors.mts';
import {writeLine} from '../../lib/io.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * Read, set, or clear the opaque per-source sync cursor (§2.6 producer contract)
 * — whatever the tracker means by "changed since". Reading an unset cursor prints
 * nothing and exits 0, which is the first-run signal to do a full sync.
 */
export const cursor: Command = {
  name: 'cursor',
  summary: 'Print the sync cursor for a source, or set/clear it.',
  usage: [
    'dispatch graph cursor [--source <name>] [--set <token> | --clear]',
    '',
    'options:',
    '  --source <name>  Cursor namespace (default: linear).',
    '  --set <token>    Store this cursor instead of printing the stored one.',
    '  --clear          Forget the stored cursor (forces the next sync to be full).',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        source: {type: 'string'},
        set: {type: 'string'},
        clear: {type: 'boolean'},
      },
      allowPositionals: false,
      strict: true,
    });

    assertUsage(
      !(values.set !== undefined && values.clear === true),
      'cursor takes --set or --clear, not both'
    );

    const source = values.source ?? 'linear';

    await withStore(values, context, async (store) => {
      if (values.clear === true) {
        const existed = await store.clearCursor(source);
        await context.log.info('cleared cursor', {source, existed});
        return;
      }

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
      if (stored !== null) await writeLine(context.stdout, stored);
      await context.log.info('read cursor', {source, cursor: stored ?? '-'});
    });
  },
};
