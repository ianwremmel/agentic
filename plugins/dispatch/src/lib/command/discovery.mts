import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {AbstractCommand} from './abstract-command.mts';
import {DefinitionError, ensure} from '../errors/index.mts';

export interface CommandNode {
  readonly name: string;
  command: AbstractCommand | undefined;
  readonly children: Map<string, CommandNode>;
}

function makeNode(name: string): CommandNode {
  return {name, command: undefined, children: new Map()};
}

/** Walk `commandsDir`, load each `.mts` command, and assemble the invocation tree. */
export async function discover(
  commandsDir: string | URL
): Promise<CommandNode> {
  const dir =
    typeof commandsDir === 'string' ? commandsDir : fileURLToPath(commandsDir);
  const root = makeNode('');

  const entries = await readdir(dir, {recursive: true, withFileTypes: true});
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.mts') &&
        !entry.name.endsWith('.test.mts')
    )
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();

  for (const relative of files) {
    const segments = relative.slice(0, -'.mts'.length).split(path.sep);
    const command = await loadCommand(dir, relative, segments);
    insert(root, segments, command);
  }

  return root;
}

async function loadCommand(
  dir: string,
  relative: string,
  segments: string[]
): Promise<AbstractCommand> {
  const href = pathToFileURL(path.join(dir, relative)).href;
  const module = (await import(href)) as Record<string, unknown>;
  const exported = module.Command;

  ensure(
    typeof exported === 'function' &&
      exported.prototype instanceof AbstractCommand,
    () =>
      new DefinitionError(
        `${relative} must export a Command class extending AbstractCommand`,
        {
          hint: `add "export class Command extends AbstractCommand { … }" to ${relative}`,
        }
      )
  );

  const Ctor = exported as new () => AbstractCommand;
  const command = new Ctor();
  const expected = segments[segments.length - 1] ?? '';

  ensure(
    command.name === expected,
    () =>
      new DefinitionError(
        `${relative} declares name "${command.name}" but its file requires "${expected}"`,
        {
          hint: `rename the command to "${expected}", or move the file to "${command.name}.mts"`,
        }
      )
  );

  return command;
}

function insert(
  root: CommandNode,
  segments: string[],
  command: AbstractCommand
): void {
  let node = root;
  for (const segment of segments) {
    let child = node.children.get(segment);
    if (child === undefined) {
      child = makeNode(segment);
      node.children.set(segment, child);
    }
    node = child;
  }
  node.command = command;
}
