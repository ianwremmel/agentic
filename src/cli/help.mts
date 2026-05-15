import type { CommandSpec } from "./types.mts";

// Render the long-form help for a single command. Used by
// `dispatch <cmd> --help`.
export function renderCommandHelp(command: CommandSpec): string {
  const lines: string[] = [];
  const usage = renderUsage(command);
  lines.push(`Usage: ${usage}`);
  lines.push("");
  lines.push(command.summary);
  if (command.description) {
    lines.push("");
    lines.push(command.description);
  }
  if (command.positionals.length > 0) {
    lines.push("");
    lines.push("Arguments:");
    for (const p of command.positionals) {
      const label = p.required ? `<${p.name}>` : `[${p.name}]`;
      lines.push(`  ${label.padEnd(22)} ${p.description}`);
    }
  }
  if (command.flags.length > 0) {
    lines.push("");
    lines.push("Flags:");
    for (const f of command.flags) {
      const head = f.alias ? `-${f.alias}, --${f.name}` : `    --${f.name}`;
      const arg = f.kind === "boolean" ? "" : ` <${f.name}>`;
      const req = f.required ? " (required)" : "";
      lines.push(`  ${(head + arg).padEnd(34)} ${f.description}${req}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function renderUsage(command: CommandSpec): string {
  const parts: string[] = [`dispatch ${command.name}`];
  // Flags are summarized as `[flags]` to keep the line short; details
  // are listed below.
  if (command.flags.length > 0) parts.push("[flags]");
  for (const p of command.positionals) {
    parts.push(p.required ? `<${p.name}>` : `[${p.name}]`);
  }
  return parts.join(" ");
}

// Render the top-level help: `dispatch --help` / `dispatch help`.
export function renderTopLevelHelp(
  commands: readonly CommandSpec[],
  version: string,
): string {
  const lines: string[] = [];
  lines.push(`dispatch ${version}`);
  lines.push("");
  lines.push("Usage: dispatch <command> [flags] [args]");
  lines.push("");
  lines.push("Commands:");
  const width = Math.max(...commands.map((c) => c.name.length)) + 2;
  // Group by section header derived from the first token.
  const groups = new Map<string, CommandSpec[]>();
  for (const c of commands) {
    const head = c.name.includes(" ") ? c.name.split(" ")[0]! : "top-level";
    const existing = groups.get(head) ?? [];
    existing.push(c);
    groups.set(head, existing);
  }
  for (const [head, cmds] of groups) {
    lines.push(`  ${head}:`);
    for (const c of cmds) {
      lines.push(`    ${c.name.padEnd(width)} ${c.summary}`);
    }
    lines.push("");
  }
  lines.push("Run `dispatch <command> --help` for command-specific help.");
  return lines.join("\n") + "\n";
}
