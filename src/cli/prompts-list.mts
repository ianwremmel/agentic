// CLI handler for `dispatch prompts list`.
//
// Iterates the event taxonomy (#26 / state/event.mts) and runs the
// layered prompt resolver (#28 / prompts/resolve.mts) for each kind.
// Emits one line per event in either TSV (default, machine-readable)
// or a padded human-readable table.
//
// Output columns: event-kind, winning-source, winning-path.
//
// Exit code is always 0 unless the resolver throws — i.e. an internal
// error such as a permission-denied read of an override path. ENOENT
// on overrides is *not* an error; it is how the layered lookup falls
// through to the built-in default.

import { DispatchError, ExitCode } from "./errors.mts";
import type { CommandHandler } from "./types.mts";
import { EVENT_KINDS } from "../state/event.mts";
import { resolvePrompt } from "../prompts/resolve.mts";

export interface PromptsListRow {
  event: string;
  source: "repo" | "user" | "built-in";
  path: string;
}

export function collectPromptsList(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): PromptsListRow[] {
  const rows: PromptsListRow[] = [];
  for (const event of EVENT_KINDS) {
    const r = resolvePrompt(event, cwd, { env });
    rows.push({ event, source: r.source, path: r.path });
  }
  return rows;
}

export function formatTSV(rows: readonly PromptsListRow[]): string {
  return rows.map((r) => `${r.event}\t${r.source}\t${r.path}`).join("\n");
}

export function formatTable(rows: readonly PromptsListRow[]): string {
  const headers: PromptsListRow = {
    event: "EVENT",
    source: "SOURCE" as PromptsListRow["source"],
    path: "PATH",
  };
  const all = [headers, ...rows];
  const wEvent = Math.max(...all.map((r) => r.event.length));
  const wSource = Math.max(...all.map((r) => r.source.length));
  const pad = (s: string, w: number): string => s + " ".repeat(w - s.length);
  return all
    .map((r) => `${pad(r.event, wEvent)}  ${pad(r.source, wSource)}  ${r.path}`)
    .join("\n");
}

export const promptsList: CommandHandler = (parsed, ctx) => {
  const fmt = parsed.flags.format;
  const format = typeof fmt === "string" ? fmt : "tsv";
  if (format !== "tsv" && format !== "table") {
    throw new DispatchError(
      ExitCode.USAGE,
      `--format must be one of: tsv, table (got ${JSON.stringify(format)})`,
      "prompts list",
    );
  }

  let rows: PromptsListRow[];
  try {
    rows = collectPromptsList(process.cwd(), process.env);
  } catch (err) {
    throw new DispatchError(
      ExitCode.GENERIC,
      `failed to resolve prompts: ${err instanceof Error ? err.message : String(err)}`,
      "prompts list",
    );
  }

  const body = format === "table" ? formatTable(rows) : formatTSV(rows);
  ctx.stdout.write(`${body}\n`);
};
