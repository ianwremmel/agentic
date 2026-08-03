import {AbstractCommand} from './abstract-command.mts';
import type {ParsedOptions, CommandContext} from './abstract-command.mts';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-unused-vars
function expectType<T>(_value: T): void {
  // asserts the argument's static type is assignable to T
}

const options = {
  force: {
    type: 'boolean',
    description: 'd',
    positional: false,
    required: false,
  },
  count: {
    type: 'number',
    description: 'd',
    positional: false,
    required: false,
    default: 1,
  },
  format: {
    type: 'string',
    description: 'd',
    positional: false,
    required: true,
    choices: ['json', 'text'],
  },
  who: {type: 'string', description: 'd', positional: true, required: false},
} as const;

class Sample extends AbstractCommand {
  readonly name = 'sample';
  readonly summary = 's';
  readonly env = [];
  readonly options = options;

  // eslint-disable-next-line @typescript-eslint/require-await
  async run(
    parsed: ParsedOptions<typeof options>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ctx: CommandContext
  ): Promise<void> {
    expectType<boolean>(parsed.force);
    expectType<number>(parsed.count);
    expectType<'json' | 'text'>(parsed.format);
    expectType<string | undefined>(parsed.who);
  }
}

// Reference the class so it is not treated as unused.
void Sample;

// Heterogeneous storage must compile: a subclass widens to AbstractCommand.
const registry: AbstractCommand[] = [new Sample()];
void registry;
