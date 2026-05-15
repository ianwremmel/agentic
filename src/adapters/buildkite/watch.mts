import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline";

import { BuildkiteAdapterError } from "./errors.mts";
import type { BuildEvent, BuildState, WatchBuildOptions } from "./types.mts";

export type SpawnLike = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface WatcherOptions {
  /** Path/name of the `bk` binary. Defaults to "bk". */
  binary?: string;
  /** Override for tests. Defaults to {@link nodeSpawn}. */
  spawn?: SpawnLike;
  /** Predicate to check whether the binary is available on PATH. */
  isAvailable?: (binary: string) => Promise<boolean>;
}

const TERMINAL_STATES = new Set<BuildState>([
  "passed",
  "failed",
  "blocked",
  "canceled",
]);

/**
 * Buildkite CI watcher. Wraps `bk build wait --json` and yields
 * one {@link BuildEvent} per parsed NDJSON line until the build
 * reaches a terminal state.
 *
 * The subprocess lifecycle is owned by the caller (e.g. the daemon
 * watch-subprocess manager, #41). This adapter only knows how to
 * spawn the process and parse its output.
 */
export class BuildkiteWatcher {
  readonly #binary: string;
  readonly #spawn: SpawnLike;
  readonly #isAvailable: (binary: string) => Promise<boolean>;

  constructor(opts: WatcherOptions = {}) {
    this.#binary = opts.binary ?? "bk";
    this.#spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnLike);
    this.#isAvailable = opts.isAvailable ?? defaultIsAvailable;
  }

  /** Returns true when the configured binary is on PATH. */
  async available(): Promise<boolean> {
    return this.#isAvailable(this.#binary);
  }

  /**
   * Watch a Buildkite build. Iteration yields one event per parsed
   * NDJSON line and ends when a terminal state is observed (or the
   * subprocess exits cleanly).
   *
   * Failure modes:
   *   - binary not on PATH → throws `binary-not-found`.
   *   - process exits with non-zero before terminal → throws
   *     `subprocess-crashed` with exit code / signal.
   *   - unparseable line → throws `parse-error`.
   */
  watchBuild(opts: WatchBuildOptions): AsyncIterable<BuildEvent> {
    return {
      [Symbol.asyncIterator]: () => this.#runWatch(opts),
    };
  }

  async *#runWatch(opts: WatchBuildOptions): AsyncGenerator<BuildEvent> {
    if (!(await this.available())) {
      throw new BuildkiteAdapterError(
        `${this.#binary} is not available on PATH`,
        { kind: "binary-not-found" },
      );
    }
    const args = [
      "build",
      "wait",
      "--json",
      "--org",
      opts.org,
      "--pipeline",
      opts.pipeline,
      String(opts.buildNumber),
    ];
    const child = this.#spawn(this.#binary, args);
    const rl: Interface = createInterface({ input: child.stdout });
    const exited = once(child, "exit") as Promise<
      [number | null, NodeJS.Signals | null]
    >;
    let sawTerminal = false;
    try {
      for await (const line of rl) {
        const text = line.trim();
        if (text.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (cause) {
          throw new BuildkiteAdapterError(
            `failed to parse bk output line: ${truncate(text, 200)}`,
            { kind: "parse-error", cause },
          );
        }
        const event = toEvent(parsed);
        yield event;
        if (event.terminal) {
          sawTerminal = true;
          break;
        }
      }
    } finally {
      if (!child.killed && child.exitCode === null) {
        child.kill();
      }
    }
    const [code, signal] = await exited;
    if (!sawTerminal && code !== 0) {
      throw new BuildkiteAdapterError(
        `bk exited (code=${String(code)}, signal=${String(signal)}) before reaching a terminal state`,
        { kind: "subprocess-crashed", exitCode: code, signal },
      );
    }
  }
}

function toEvent(raw: unknown): BuildEvent {
  if (typeof raw !== "object" || raw === null) {
    return { raw, state: "running", terminal: false };
  }
  const obj = raw as Record<string, unknown>;
  const stateValue = typeof obj.state === "string" ? obj.state : "running";
  const state = normalize(stateValue);
  const event: BuildEvent = {
    raw,
    state,
    terminal: TERMINAL_STATES.has(state),
  };
  if (typeof obj.number === "number") event.buildNumber = obj.number;
  if (typeof obj.url === "string") event.url = obj.url;
  if (typeof obj.pipeline === "string") event.pipeline = obj.pipeline;
  return event;
}

function normalize(s: string): BuildState {
  switch (s.toLowerCase()) {
    case "passed":
      return "passed";
    case "failed":
    case "failing":
      return "failed";
    case "blocked":
      return "blocked";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "running";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

async function defaultIsAvailable(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = nodeSpawn(binary, ["--version"], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("exit", (code) => resolve(code === 0));
  });
}
