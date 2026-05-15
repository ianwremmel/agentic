import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline";

import { ActionsAdapterError } from "./errors.mts";
import type {
  CheckSummary,
  ChecksEvent,
  ChecksRollupState,
  WatchChecksOptions,
} from "./types.mts";

export type SpawnLike = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface WatcherOptions {
  /** Path/name of the `gh` binary. Defaults to "gh". */
  binary?: string;
  /** Override for tests. Defaults to {@link nodeSpawn}. */
  spawn?: SpawnLike;
  /** Predicate to check whether the binary is available on PATH. */
  isAvailable?: (binary: string) => Promise<boolean>;
}

const JSON_FIELDS = "bucket,name,state,conclusion,startedAt,completedAt";

/**
 * GitHub Actions CI watcher. Wraps `gh pr checks <pr> --watch --json …`
 * and yields one {@link ChecksEvent} per snapshot until the rollup
 * reaches a terminal state (`success` or `failure`).
 *
 * The subprocess lifecycle is owned by the caller (e.g. the daemon
 * watch-subprocess manager, #41). This adapter only knows how to
 * spawn the process and parse its output.
 */
export class ActionsWatcher {
  readonly #binary: string;
  readonly #spawn: SpawnLike;
  readonly #isAvailable: (binary: string) => Promise<boolean>;

  constructor(opts: WatcherOptions = {}) {
    this.#binary = opts.binary ?? "gh";
    this.#spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnLike);
    this.#isAvailable = opts.isAvailable ?? defaultIsAvailable;
  }

  /** Returns true when the configured binary is on PATH. */
  async available(): Promise<boolean> {
    return this.#isAvailable(this.#binary);
  }

  /**
   * Watch the check rollup on a pull request. Iteration yields one
   * event per parsed JSON snapshot and ends when a terminal state
   * (`success` or `failure`) is observed (or the subprocess exits
   * cleanly).
   *
   * Failure modes:
   *   - binary not on PATH → throws `binary-not-found`.
   *   - process exits with non-zero before terminal → throws
   *     `subprocess-crashed` with exit code / signal.
   *   - unparseable line → throws `parse-error`.
   */
  watchChecks(opts: WatchChecksOptions): AsyncIterable<ChecksEvent> {
    return {
      [Symbol.asyncIterator]: () => this.#runWatch(opts),
    };
  }

  async *#runWatch(opts: WatchChecksOptions): AsyncGenerator<ChecksEvent> {
    if (!(await this.available())) {
      throw new ActionsAdapterError(
        `${this.#binary} is not available on PATH`,
        { kind: "binary-not-found" },
      );
    }
    const args = [
      "pr",
      "checks",
      String(opts.prNumber),
      "--repo",
      opts.repo,
      "--watch",
      "--json",
      JSON_FIELDS,
    ];
    const child = this.#spawn(this.#binary, args);
    const rl: Interface = createInterface({ input: child.stdout });
    const exited = once(child, "exit") as Promise<
      [number | null, NodeJS.Signals | null]
    >;
    let sawTerminal = false;
    let buffer = "";
    try {
      for await (const line of rl) {
        const text = line.trim();
        if (text.length === 0) continue;
        buffer += text;
        let parsed: unknown;
        try {
          parsed = JSON.parse(buffer);
        } catch {
          // `gh --json` may pretty-print across multiple lines. Accumulate
          // until we have a complete JSON document.
          continue;
        }
        buffer = "";
        const event = toEvent(parsed);
        yield event;
        if (event.terminal) {
          sawTerminal = true;
          break;
        }
      }
      if (buffer.length > 0) {
        throw new ActionsAdapterError(
          `failed to parse gh output: ${truncate(buffer, 200)}`,
          { kind: "parse-error" },
        );
      }
    } finally {
      if (!child.killed && child.exitCode === null) {
        child.kill();
      }
    }
    const [code, signal] = await exited;
    if (!sawTerminal && code !== 0) {
      throw new ActionsAdapterError(
        `gh exited (code=${String(code)}, signal=${String(signal)}) before reaching a terminal state`,
        { kind: "subprocess-crashed", exitCode: code, signal },
      );
    }
  }
}

function toEvent(raw: unknown): ChecksEvent {
  const checks = extractChecks(raw);
  const state = rollup(checks);
  const event: ChecksEvent = {
    raw,
    state,
    terminal: state === "success" || state === "failure",
  };
  if (checks) event.checks = checks;
  return event;
}

function extractChecks(raw: unknown): CheckSummary[] | undefined {
  if (Array.isArray(raw)) {
    return raw.filter(
      (c): c is CheckSummary => typeof c === "object" && c !== null,
    );
  }
  return undefined;
}

function rollup(checks: CheckSummary[] | undefined): ChecksRollupState {
  if (!checks || checks.length === 0) return "pending";
  let anyPending = false;
  let anyFailure = false;
  for (const c of checks) {
    const bucket = typeof c.bucket === "string" ? c.bucket.toLowerCase() : "";
    if (bucket === "fail" || bucket === "cancel") {
      anyFailure = true;
    } else if (bucket === "pending" || bucket === "") {
      anyPending = true;
    }
  }
  if (anyPending) return "pending";
  if (anyFailure) return "failure";
  return "success";
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
