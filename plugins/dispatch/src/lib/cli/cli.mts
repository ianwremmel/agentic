import {parseArgs} from 'node:util';
import type {Writable} from 'node:stream';

import type {Logger} from '../logger/index.mts';
import {parseOptions, assertEnv} from '../command/index.mts';
import type {AbstractCommand, CommandNode, Option} from '../command/index.mts';
import {DispatchError, UsageError, assertUsage} from '../errors/index.mts';

export interface RunCliOptions {
  readonly argv: readonly string[];
  readonly tree: CommandNode;
  readonly log: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

interface Walked {
  readonly path: string[];
  readonly node: CommandNode;
  readonly rest: string[];
}

/** Parse argv against the command tree, run the matched command, return an exit code. */
export async function runCli(options: RunCliOptions): Promise<number> {
  const {argv, tree, log, env, stdout, stderr} = options;
  try {
    const walked = walk(tree, argv);

    if (wantsHelp(argv)) {
      stdout.write(`${usageText(walked)}\n`);
      return 0;
    }

    const {node, rest, path} = walked;
    const command = node.command;

    if (command === undefined) {
      const label = path.length > 0 ? path.join(' ') : 'dispatch';
      const children = [...node.children.keys()].sort().join(', ');
      throw new UsageError(
        rest.length > 0
          ? `unknown subcommand "${rest[0] ?? ''}" for ${label}`
          : `${label} needs a subcommand`,
        children === ''
          ? {
              hint: 'this command tree has no commands; the installation is broken.',
            }
          : {hint: `run one of: ${children}`}
      );
    }

    const parsed = parseCommandArgs(command, rest);
    assertEnv(command.env, env);
    await command.run(parsed, {log, env});
    return 0;
  } catch (error) {
    if (error instanceof DispatchError) {
      stderr.write(`error: ${error.toString()}\n`);
      return error.exitCode;
    }
    stderr.write(`error: ${String(error)}\n`);
    return 1;
  }
}

/** Descend the tree along leading command-name tokens, ignoring help flags. */
function walk(root: CommandNode, argv: readonly string[]): Walked {
  let node = root;
  const path: string[] = [];
  const tokens = [...argv];
  let index = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === '--') break;
    if (token === '--help' || token === '-h') continue;
    if (token.startsWith('-')) break;
    const child = node.children.get(token);
    if (child === undefined) break;
    node = child;
    path.push(token);
  }
  return {path, node, rest: tokens.slice(index)};
}

/**
 * Whether `--help`/`-h` appears anywhere before a `--` terminator. A command
 * that needs a literal `--help` option value must have its caller pass it
 * after `--`.
 */
function wantsHelp(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === '--') return false;
    if (token === '--help' || token === '-h') return true;
  }
  return false;
}

function parseCommandArgs(
  command: AbstractCommand,
  rest: readonly string[]
): Record<string, unknown> {
  const flagConfig: Record<string, {type: 'string' | 'boolean'}> = {};
  const positionalNames: string[] = [];
  for (const [key, option] of Object.entries(command.options)) {
    if (option.positional) {
      positionalNames.push(key);
    } else {
      flagConfig[key] = {
        type: option.type === 'boolean' ? 'boolean' : 'string',
      };
    }
  }

  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...rest],
      options: flagConfig,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    throw toUsageError(error);
  }

  assertUsage(
    positionals.length <= positionalNames.length,
    `unexpected argument: ${positionals[positionalNames.length] ?? ''}`
  );

  const raw: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) raw[key] = value;
  }
  positionalNames.forEach((name, position) => {
    const value = positionals[position];
    if (value !== undefined) raw[name] = value;
  });

  return parseOptions(command.options, raw);
}

/** Re-tag a `node:util` parse failure as a usage error; rethrow anything else. */
function toUsageError(error: unknown): UsageError {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS_')
  ) {
    return new UsageError(error.message, {cause: error});
  }
  throw error;
}

function usageText(walked: Walked): string {
  const {path, node} = walked;
  const invocation = ['dispatch', ...path].join(' ');
  const lines: string[] = [];

  if (node.command === undefined) {
    lines.push(`usage: ${invocation} <subcommand>`);
  } else {
    const parts = Object.entries(node.command.options).map(([key, option]) =>
      optionUsage(key, option)
    );
    lines.push(`usage: ${[invocation, ...parts].join(' ')}`);
    lines.push('');
    lines.push(node.command.summary);
  }

  if (node.children.size > 0) {
    lines.push('');
    lines.push('subcommands:');
    lines.push(...childLines(node));
  }

  return lines.join('\n');
}

function optionUsage(key: string, option: Option): string {
  if (option.positional) {
    const label = option.choices ? option.choices.join('|') : key;
    return option.required ? `<${label}>` : `[<${label}>]`;
  }
  if (option.type === 'boolean') {
    return `[--${key}]`;
  }
  const value = option.choices ? option.choices.join('|') : option.type;
  return option.required ? `--${key} <${value}>` : `[--${key} <${value}>]`;
}

function childLines(node: CommandNode): string[] {
  const names = [...node.children.keys()].sort();
  const width = Math.max(...names.map((name) => name.length));
  return names.map((name) => {
    const summary = node.children.get(name)?.command?.summary ?? '';
    return `  ${name.padEnd(width)}  ${summary}`.trimEnd();
  });
}
