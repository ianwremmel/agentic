import {spawn} from 'node:child_process';

/** The outcome of running an external process to completion. */
export interface RunResult {
  /** Exit code, or 128 + signal number when the process was killed by a signal. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** Written to the child's stdin, which is then closed. Omit for no input. */
  readonly stdin?: string;
  /** Kill the child after this many ms and resolve with its partial output. */
  readonly timeoutMs?: number;
  /** Extra environment merged over the parent's, e.g. `GIT_INDEX_FILE`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Run an external command and collect its output. The single seam between the
 * `pr-status` logic and the outside world (`gh`, `git`, `claude`): tests inject
 * a fake Runner and never spawn a real process.
 *
 * Resolves with the exit code and captured streams for ANY completed run,
 * including a non-zero exit — callers branch on `code` the way the shell script
 * branched on `$?`. Rejects only when the process could not be started at all
 * (e.g. the binary is not on PATH), so a missing tool is distinguishable from a
 * tool that ran and failed.
 */
export type Runner = (
  command: string,
  args: readonly string[],
  options?: RunOptions
) => Promise<RunResult>;

/** The production {@link Runner}: a real child process, no shell. */
export const spawnRunner: Runner = (command, args, options = {}) =>
  new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.env ? {env: {...process.env, ...options.env}} : {}),
    });

    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    // A broken pipe when the child exits before reading all of stdin is not our
    // failure to report — the exit code is. Swallow it so it doesn't reject.
    child.stdin.on('error', () => undefined);

    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      const resolvedCode =
        code ?? (signal === null ? 1 : 128 + signalNumber(signal));
      resolve({code: timedOut ? 124 : resolvedCode, stdout, stderr});
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs);
    }

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });

/** Best-effort signal name → number, for a stable non-zero exit code. */
function signalNumber(signal: NodeJS.Signals): number {
  const known: Record<string, number> = {
    SIGKILL: 9,
    SIGTERM: 15,
    SIGINT: 2,
  };
  return known[signal] ?? 1;
}
