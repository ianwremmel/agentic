import type {CommandNode, AbstractCommand, Option} from '../command/index.mts';
import {resolveTransports} from '../command/index.mts';

interface PropertySchema {
  type: 'string' | 'number' | 'boolean';
  description: string;
  enum?: readonly string[];
  default?: string | number | boolean;
}

export interface JsonSchema {
  readonly type: 'object';
  readonly properties: Record<string, PropertySchema>;
  readonly required?: readonly string[];
}

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface BuiltTools {
  readonly defs: readonly ToolDef[];
  readonly byName: ReadonlyMap<string, AbstractCommand>;
}

/** Walk the command tree into MCP tool defs plus a name -> command lookup. */
export function buildTools(tree: CommandNode): BuiltTools {
  const defs: ToolDef[] = [];
  const byName = new Map<string, AbstractCommand>();
  walk(tree, [], defs, byName);
  return {defs, byName};
}

function walk(
  node: CommandNode,
  path: string[],
  defs: ToolDef[],
  byName: Map<string, AbstractCommand>
): void {
  const command = node.command;
  if (command !== undefined && resolveTransports(command).mcp) {
    const name = path.join('_');
    defs.push({
      name,
      description: command.summary,
      inputSchema: inputSchema(command),
    });
    byName.set(name, command);
  }
  for (const [segment, child] of node.children) {
    walk(child, [...path, segment], defs, byName);
  }
}

function inputSchema(command: AbstractCommand): JsonSchema {
  const properties: Record<string, PropertySchema> = {};
  const required: string[] = [];
  for (const [key, option] of Object.entries(command.options)) {
    properties[key] = propertySchema(option);
    if (option.required) required.push(key);
  }
  return required.length > 0
    ? {type: 'object', properties, required}
    : {type: 'object', properties};
}

function propertySchema(option: Option): PropertySchema {
  const schema: PropertySchema = {
    type: option.type,
    description: option.description,
  };
  if (option.choices !== undefined) schema.enum = option.choices;
  if (option.default !== undefined) schema.default = option.default;
  return schema;
}
