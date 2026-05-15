// Runner non-zero exit triage + `runner-error` event synthesis per
// docs/spec/03-cli/01-daemon/02-normative.md §Non-zero exits. Closes #40.
//
// Two-tier handling:
//   1. Hard-coded classifier for runner-not-found, usage error,
//      prompt-resolution failure, OOM. Each routes to either a clean
//      abort (config error) or a capped-backoff retry (transient).
//   2. Everything else synthesizes a `runner-error` event so the
//      triage prompt can decide what to do.

import type { DispatchEvent } from "../state/event.mts";

/** Action the daemon should take after the classifier runs. */
export type TriageDisposition =
  | { kind: "abort"; reason: TriageReason; message: string }
  | { kind: "retry"; reason: TriageReason; message: string }
  | { kind: "synthesize"; event: DispatchEvent };

export type TriageReason =
  | "runner-not-found"
  | "usage-error"
  | "prompt-resolution-failure"
  | "oom";

export interface RunnerExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Captured stdout, oldest-first. May exceed the 64 KB tail cap. */
  stdout: string;
  /** Captured stderr, oldest-first. May exceed the 64 KB tail cap. */
  stderr: string;
  /** Optional explicit reason hook for hard signals like ENOENT. */
  spawnError?: { code?: string; message: string };
}

export interface TriageInput {
  task: { id: string };
  /** Original event that triggered the spawn. */
  originalEvent: DispatchEvent;
  exit: RunnerExit;
  /** Override the clock; defaults to `Date.now`. */
  now?: () => Date;
}

/** Cap on the stdout/stderr tails embedded in synthesized events. */
export const STREAM_TAIL_BYTES = 64 * 1024;

const ABORT_REASONS: ReadonlySet<TriageReason> = new Set<TriageReason>([
  "runner-not-found",
  "usage-error",
  "prompt-resolution-failure",
]);

const RETRY_REASONS: ReadonlySet<TriageReason> = new Set<TriageReason>(["oom"]);

/**
 * Classify a runner exit. Hard-coded triage matches the
 * representative exit codes / spawn errors from §Non-zero exits;
 * everything else is wrapped in a `runner-error` synthetic event.
 *
 * The triage prompt MUST NOT silently swallow failures — the
 * synthesized event always carries the exit code, tails, and the
 * verbatim original event payload so the prompt has enough context
 * to decide on follow-up actions.
 */
export function triageRunnerExit(input: TriageInput): TriageDisposition {
  const { exit } = input;
  const reason = classify(exit);
  if (reason !== null) {
    const message = describe(reason, exit);
    if (ABORT_REASONS.has(reason)) {
      return { kind: "abort", reason, message };
    }
    if (RETRY_REASONS.has(reason)) {
      return { kind: "retry", reason, message };
    }
  }
  const now = (input.now ?? (() => new Date()))();
  const event: DispatchEvent = {
    kind: "runner-error",
    task_id: input.task.id,
    timestamp: now.toISOString(),
    payload: {
      exit_code: exit.exitCode,
      signal: exit.signal,
      stdout_tail: tail(exit.stdout, STREAM_TAIL_BYTES),
      stderr_tail: tail(exit.stderr, STREAM_TAIL_BYTES),
      original_event: input.originalEvent,
    },
  };
  return { kind: "synthesize", event };
}

function classify(exit: RunnerExit): TriageReason | null {
  if (exit.spawnError?.code === "ENOENT") return "runner-not-found";
  if (exit.signal === "SIGKILL" && looksOomKilled(exit.stderr)) return "oom";
  switch (exit.exitCode) {
    case 127:
      return "runner-not-found";
    case 2:
      return "usage-error";
    case 64:
      return "usage-error";
    case 66:
      return "prompt-resolution-failure";
    case 137:
      return "oom";
    default:
      return null;
  }
}

function looksOomKilled(stderr: string): boolean {
  return /\bOut of memory\b|\bOOM\b|killed: 9\b/i.test(stderr);
}

function describe(reason: TriageReason, exit: RunnerExit): string {
  switch (reason) {
    case "runner-not-found":
      return `runner binary not found (code=${exit.exitCode ?? "?"}${exit.spawnError ? `, spawn error=${exit.spawnError.code ?? exit.spawnError.message}` : ""})`;
    case "usage-error":
      return `runner reported usage error (code=${exit.exitCode ?? "?"})`;
    case "prompt-resolution-failure":
      return `runner could not resolve the prompt (code=${exit.exitCode ?? "?"})`;
    case "oom":
      return `runner killed by OOM (code=${exit.exitCode ?? "?"}, signal=${exit.signal ?? "?"})`;
  }
}

/**
 * Return the last `bytes` bytes of `text` (UTF-8). When truncation
 * happens, prefix with an ellipsis so consumers can detect it.
 */
export function tail(text: string, bytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return text;
  return `…${buf.subarray(buf.length - bytes).toString("utf8")}`;
}
