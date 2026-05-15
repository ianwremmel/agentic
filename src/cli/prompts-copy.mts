// CLI handler for `dispatch prompts copy <event> (--repo | --home) [--force]`.
//
// Copies the built-in default prompt template (#27, embedded in the SEA
// asset map) for the given event kind to either the repo-local or the
// per-user override location.
//
// Exit codes (per AC of #54):
//   3 (NOT_FOUND)   — unknown event kind
//   1 (GENERIC)     — target file already exists and --force was not passed
//                   — or some other I/O failure while writing
//   0               — wrote the file (creating any missing parent dirs)
//
// The router already enforces "exactly one of --repo or --home" via
// `oneOfRequired` / `mutuallyExclusive` validation, so we treat that as
// a hard invariant here.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DispatchError, ExitCode } from "./errors.mts";
import type { CommandHandler } from "./types.mts";
import { isEventKind, type EventKind } from "../state/event.mts";
import { getBuiltinPrompt } from "../prompts/index.mts";

export interface PromptsCopyDeps {
  cwd: () => string;
  env: NodeJS.ProcessEnv;
  readBuiltin: (event: EventKind) => string;
  exists: (path: string) => boolean;
  mkdirp: (path: string) => void;
  writeFile: (path: string, content: string) => void;
}

export interface PromptsCopyOptions {
  event: string;
  target: "repo" | "home";
  force: boolean;
}

export interface PromptsCopyResult {
  destination: string;
  bytesWritten: number;
}

function resolveUserConfigDir(
  env: NodeJS.ProcessEnv,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "dispatch");
  return join(env.HOME ?? homedir(), ".config", "dispatch");
}

export function resolveDestination(
  event: EventKind,
  target: "repo" | "home",
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  if (target === "repo") {
    return join(cwd, ".dispatch", "prompts", `${event}.xml`);
  }
  return join(resolveUserConfigDir(env), "prompts", `${event}.xml`);
}

export function runPromptsCopy(
  deps: PromptsCopyDeps,
  opts: PromptsCopyOptions,
): PromptsCopyResult {
  if (!isEventKind(opts.event)) {
    throw new DispatchError(
      ExitCode.NOT_FOUND,
      `unknown event kind: ${JSON.stringify(opts.event)}`,
      "prompts copy",
    );
  }

  const dest = resolveDestination(opts.event, opts.target, deps.cwd(), deps.env);

  if (deps.exists(dest) && !opts.force) {
    throw new DispatchError(
      ExitCode.GENERIC,
      `target already exists: ${dest} (pass --force to overwrite)`,
      "prompts copy",
    );
  }

  const content = deps.readBuiltin(opts.event);

  try {
    deps.mkdirp(dirname(dest));
    deps.writeFile(dest, content);
  } catch (err) {
    throw new DispatchError(
      ExitCode.GENERIC,
      `failed to write ${dest}: ${err instanceof Error ? err.message : String(err)}`,
      "prompts copy",
    );
  }

  return { destination: dest, bytesWritten: Buffer.byteLength(content, "utf8") };
}

function defaultDeps(): PromptsCopyDeps {
  return {
    cwd: () => process.cwd(),
    env: process.env,
    readBuiltin: (event) => getBuiltinPrompt(event).content,
    exists: existsSync,
    mkdirp: (p) => {
      mkdirSync(p, { recursive: true });
    },
    writeFile: (p, c) => {
      writeFileSync(p, c, "utf8");
    },
  };
}

export const promptsCopy: CommandHandler = (parsed, ctx) => {
  const event = parsed.positionals.event;
  if (event === undefined) {
    throw new DispatchError(
      ExitCode.USAGE,
      `missing required positional: event`,
      "prompts copy",
    );
  }
  const repo = parsed.flags.repo === true;
  const home = parsed.flags.home === true;
  const force = parsed.flags.force === true;
  const target: "repo" | "home" = repo ? "repo" : "home";
  // Router validation guarantees exactly one of (repo, home).
  if (!repo && !home) {
    throw new DispatchError(
      ExitCode.USAGE,
      `exactly one of --repo or --home is required`,
      "prompts copy",
    );
  }

  const result = runPromptsCopy(defaultDeps(), { event, target, force });
  ctx.stdout.write(`wrote ${result.destination} (${result.bytesWritten} bytes)\n`);
};
