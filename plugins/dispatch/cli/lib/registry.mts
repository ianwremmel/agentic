import assert from 'node:assert';

import type {Command} from './command.mts';
import {graph} from '../commands/graph.mts';
import {greet} from '../commands/greet.mts';
import {mcp} from '../commands/mcp.mts';
import {wait} from '../commands/wait.mts';

/**
 * Every command the CLI exposes. Skills reach these through `bin/dispatch`;
 * adding one means adding it here and nowhere else.
 */
export const COMMANDS: readonly Command[] = [graph, greet, mcp, wait];

const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));
assert.equal(
  BY_NAME.size,
  COMMANDS.length,
  'command names must be unique — a duplicate silently shadows an earlier command'
);

export function findCommand(name: string): Command | undefined {
  return BY_NAME.get(name);
}

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const commands = COMMANDS.map(
    (command) => `  ${command.name.padEnd(width)}  ${command.summary}`
  ).join('\n');

  return [
    'usage: dispatch [--log-level <level>] <command> [args...]',
    '',
    'commands:',
    commands,
    '',
    'options:',
    '  -h, --help          Show this help.',
    '      --log-level     debug | info | warn | error (default: info).',
    '                      Also settable via DISPATCH_LOG_LEVEL.',
  ].join('\n');
}
