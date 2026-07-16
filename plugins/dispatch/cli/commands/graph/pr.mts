import assert from 'node:assert';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage, UsageError} from '../../lib/errors.mts';
import {group} from '../../lib/subcommand.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * Runtime injection of a ticketless PR: stored as a claimable work item keyed
 * `<repo>#<number>` (target-kind `bare-pr`) in the synthetic undeclared
 * project `pr:<repo>`, injected so `next` returns it ahead of ranked ticket
 * work. `delivered` is terminal for it; remove a mistaken entry with `task rm`.
 */
const add: Command = {
  name: 'add',
  summary: 'Inject a bare PR as a top-priority work item.',
  usage: [
    'dispatch graph pr add --repo o/r --pr 7 --url https://github.com/o/r/pull/7 \\',
    '    [--branch feat/x] [--title "fix the thing"]',
    '',
    'options:',
    '  --repo <owner/name>  Forge repository (required).',
    '  --pr <number>        PR number (required).',
    '  --url <url>          PR url (required).',
    '  --branch <name>      Head branch, as a hint for the coordinator.',
    '  --title <text>       Display title (default: the item key).',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        repo: {type: 'string'},
        pr: {type: 'string'},
        url: {type: 'string'},
        branch: {type: 'string'},
        title: {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });
    assertUsage(
      values.repo !== undefined && values.repo !== '',
      'pr add needs --repo (owner/name)'
    );
    assertUsage(
      values.url !== undefined && values.url !== '',
      'pr add needs --url'
    );
    const number = Number(values.pr);
    assert(
      values.pr !== undefined && Number.isInteger(number) && number > 0,
      new UsageError(
        `--pr must be a positive integer, not "${values.pr ?? ''}"`,
        {
          hint: 'e.g. --pr 152.',
        }
      )
    );

    await withStore(values, context, async (store) => {
      const id = await store.addBarePr({
        repo: values.repo ?? '',
        number,
        url: values.url ?? '',
        branch: values.branch ?? null,
        title: values.title ?? null,
      });
      await context.log.info('injected bare pr', {task: id});
    });
  },
};

export const pr = group({
  name: 'pr',
  summary: 'Inject ticketless PRs as work items.',
  children: [add],
});
