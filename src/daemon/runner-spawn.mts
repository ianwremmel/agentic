// Runner spawn contract per docs/spec/03-cli/01-daemon/02-normative.md
// §Spawn contract. Implements #39.
//
// This module is intentionally narrow: it owns the *single* act of
// spawning the runner once and returning its exit code + (on first
// spawn) the captured session ID. Lifecycle concerns (re-spawn on
// `runner-error`, concurrency caps, follow-up coalescing) live in
// separate daemon modules.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { stat } from "node:fs/promises";

import type { RunnerConfig } from "../config/schema.mts";

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => ChildProcessWithoutNullStreams;

/** Sink for stdout/stderr lines captured during a spawn. */
export interface RunnerLogSink {
  /** Called once per line. The implementation prefixes with the task id. */
  write(stream: "stdout" | "stderr", line: string): void;
}

export interface SpawnRunnerInput {
  task: {
    /** Canonical task ID (used as the log prefix). */
    id: string;
    /** Absolute worktree path; MUST exist. */
    worktree: string;
    /**
     * Session ID stored on the task record. Required when `isResume`,
     * ignored otherwise.
     */
    sessionId?: string | null;
  };
  /** `bootstrap`, `pr-comment`, `runner-error`, … */
  eventKind: string;
  /** Path to the event payload JSON written by the daemon. */
  eventPayloadPath: string;
  /** Path to the resolved prompt file passed via `--prompt-file`. */
  promptFile: string;
  /**
   * False for the first spawn against a task; true on every subsequent
   * spawn. When true, `task.sessionId` MUST be a non-empty string.
   */
  isResume: boolean;
}

export interface SpawnRunnerResult {
  pid: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Session ID captured from runner output. Null on resume spawns. */
  sessionId: string | null;
}

export interface RunnerSpawnerOptions {
  runner: RunnerConfig;
  /** Override the spawner. Defaults to {@link nodeSpawn}. */
  spawn?: SpawnLike;
  /**
   * Sink for stdio. The daemon binds this to `daemon.log` with a
   * `[task-id] ` line prefix; tests use an in-memory collector.
   */
  log: RunnerLogSink;
  /**
   * Override worktree existence check. Defaults to a real stat.
   */
  worktreeExists?: (path: string) => Promise<boolean>;
}

export class RunnerSpawnError extends Error {
  readonly kind:
    | "worktree-missing"
    | "missing-session-id"
    | "no-session-id-captured";
  constructor(message: string, kind: RunnerSpawnError["kind"]) {
    super(message);
    this.name = "RunnerSpawnError";
    this.kind = kind;
  }
}

export class RunnerSpawner {
  readonly #runner: RunnerConfig;
  readonly #spawn: SpawnLike;
  readonly #log: RunnerLogSink;
  readonly #worktreeExists: (path: string) => Promise<boolean>;

  constructor(opts: RunnerSpawnerOptions) {
    this.#runner = opts.runner;
    this.#spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnLike);
    this.#log = opts.log;
    this.#worktreeExists = opts.worktreeExists ?? defaultWorktreeExists;
  }

  async spawnRunner(input: SpawnRunnerInput): Promise<SpawnRunnerResult> {
    if (!(await this.#worktreeExists(input.task.worktree))) {
      throw new RunnerSpawnError(
        `task worktree does not exist: ${input.task.worktree}`,
        "worktree-missing",
      );
    }
    if (input.isResume) {
      if (
        typeof input.task.sessionId !== "string" ||
        input.task.sessionId.length === 0
      ) {
        throw new RunnerSpawnError(
          `resume spawn requires a session ID on the task record (task=${input.task.id})`,
          "missing-session-id",
        );
      }
    }

    const args = buildArgs(this.#runner, input);
    const child = this.#spawn(this.#runner.binary, args, {
      cwd: input.task.worktree,
    });

    const captureStream = this.#runner.sessionIdCapture;
    let capturedSessionId: string | null = null;

    const handleLine = (stream: "stdout" | "stderr", line: string): void => {
      this.#log.write(stream, line);
      if (input.isResume) return;
      const expected =
        captureStream === "stdout-jsonline" ? "stdout" : "stderr";
      if (stream !== expected) return;
      if (capturedSessionId !== null) return;
      const id = parseSessionId(line);
      if (id !== null) capturedSessionId = id;
    };

    const stdoutRl = createInterface({ input: child.stdout });
    const stderrRl = createInterface({ input: child.stderr });
    const stdoutClosed = once(stdoutRl, "close");
    const stderrClosed = once(stderrRl, "close");
    stdoutRl.on("line", (line) => handleLine("stdout", line));
    stderrRl.on("line", (line) => handleLine("stderr", line));

    const [code, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    // Make sure readline finishes draining queued lines synchronously
    // emitted before exit. Both interfaces close once their underlying
    // streams emit `end`; awaiting them keeps us deterministic.
    await Promise.all([stdoutClosed, stderrClosed]);

    if (!input.isResume && code === 0 && capturedSessionId === null) {
      throw new RunnerSpawnError(
        `runner exited successfully but no session ID was captured from ${captureStream}`,
        "no-session-id-captured",
      );
    }

    return {
      pid: child.pid ?? -1,
      exitCode: code,
      signal,
      sessionId: capturedSessionId,
    };
  }
}

function buildArgs(runner: RunnerConfig, input: SpawnRunnerInput): string[] {
  const args: string[] = [...runner.extraArgs];
  if (input.isResume && input.task.sessionId) {
    args.push(runner.resumeFlag, input.task.sessionId);
  }
  args.push("--cwd", input.task.worktree);
  args.push("--prompt-file", input.promptFile);
  args.push("--env", `DISPATCH_TASK_ID=${input.task.id}`);
  args.push("--env", `DISPATCH_EVENT=${input.eventKind}`);
  args.push("--env", `DISPATCH_EVENT_PAYLOAD=${input.eventPayloadPath}`);
  return args;
}

function parseSessionId(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== "{") return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const candidate = obj.session_id ?? obj.sessionId;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

async function defaultWorktreeExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
