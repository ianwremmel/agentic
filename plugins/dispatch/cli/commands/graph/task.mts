import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {assertUsage} from '../../lib/errors.mts';
import {resolveTask} from '../../lib/graph/task-input.mts';
import {group} from '../../lib/subcommand.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * Upsert one task. The agent passes the tracker's native `--state` and `--labels`;
 * the role, target-kind, and human-interactive flag are derived from them.
 */
const set: Command = {
  name: 'set',
  summary: 'Create or update one task.',
  usage: [
    'dispatch graph task set --id CLC-945 --project P --state "In Progress" \\',
    '    [--milestone M1] [--priority 2] [--url U] [--title T] \\',
    '    [--labels infra,qa] [--branch-hint b] [--injected] [--updated-at TS]',
    '',
    'options:',
    '  --id <id>          Tracker identifier, e.g. CLC-945 (required).',
    '  --project <id>     Project the task belongs to (required).',
    "  --state <state>    The tracker's native state; mapped to a role (required).",
    '  --milestone <id>   Milestone membership.',
    '  --labels <a,b>     Comma-separated; derive target-kind and human-interactive.',
    '  --priority <n>     Lower is more urgent; omit if the tracker has none.',
    '  --injected         Rank this task to the top of the frontier (§2.6).',
    '  --tracker <name>   Tracker whose state mapping applies (default: linear).',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        id: {type: 'string'},
        project: {type: 'string'},
        state: {type: 'string'},
        milestone: {type: 'string'},
        priority: {type: 'string'},
        url: {type: 'string'},
        title: {type: 'string'},
        labels: {type: 'string'},
        'branch-hint': {type: 'string'},
        'updated-at': {type: 'string'},
        injected: {type: 'boolean'},
        tracker: {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });

    const tracker = values.tracker ?? 'linear';

    await withStore(values, context, async (store, config) => {
      const task = resolveTask(
        {
          id: values.id,
          project: values.project,
          state: values.state,
          milestone: values.milestone,
          priority: values.priority,
          url: values.url,
          title: values.title,
          labels: values.labels,
          branchHint: values['branch-hint'],
          updatedAt: values['updated-at'],
          injected: values.injected === true,
        },
        {tracker, config}
      );

      await store.upsertTask(task);
      await context.log.info('set task', {
        task: task.id,
        role: task.role,
        target_kind: task.targetKind,
      });
    });
  },
};

const rm: Command = {
  name: 'rm',
  summary: 'Delete a task, its edges, and any claim on it.',
  usage: ['dispatch graph task rm --id CLC-945', '', STORE_USAGE].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {...STORE_OPTIONS, id: {type: 'string'}},
      allowPositionals: false,
      strict: true,
    });

    const id = values.id;
    assertUsage(id !== undefined && id !== '', 'task rm needs --id');

    await withStore(values, context, async (store) => {
      const removed = await store.removeTask(id);
      await context.log.info('removed task', {task: id, existed: removed});
    });
  },
};

export const task = group({
  name: 'task',
  path: 'graph task',
  summary: 'Create, update, or delete tasks.',
  children: [set, rm],
});
