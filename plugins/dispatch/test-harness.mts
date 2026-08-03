import {execFile, spawn} from 'node:child_process';
import {constants} from 'node:os';
import {once} from 'node:events';
import {chmod, mkdtemp, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {text} from 'node:stream/consumers';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

/** The bash wrapper under test — the same path skills invoke. */
export const DISPATCH_BIN = path.join(import.meta.dirname, 'bin', 'dispatch');

/** The MCP wrapper under test — the same path `.mcp.json` names. */
export const DISPATCH_MCP_BIN = path.join(
  import.meta.dirname,
  'bin',
  'dispatch-mcp'
);

export interface DispatchResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DispatchOptions {
  /** Merged over a minimal base env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Written to the CLI's stdin, the way a skill pipes a payload to it. */
  readonly input?: string;
  /** Which wrapper to run; defaults to `bin/dispatch`. */
  readonly bin?: string;
}

/**
 * Run the wrapper the way a skill would, and report what a caller sees: exit
 * code, stdout, stderr. A non-zero exit is a result, not a test failure.
 *
 * Spawned rather than exec'd so a test can pipe a payload in: the MCP server
 * reads stdin, and the pipe is the path the runner actually uses.
 */
export async function runDispatch(
  args: readonly string[],
  {env = {}, input, bin = DISPATCH_BIN}: DispatchOptions = {}
): Promise<DispatchResult> {
  const child = spawn(bin, [...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...env,
    },
  });

  child.stdin.end(input ?? '');

  const [stdout, stderr, code] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    // A process killed by a signal exits with a null code. Reporting that as a
    // plain 1 would let a crashed or killed CLI pass for an ordinary failure, so
    // it becomes 128 + signal, the way a shell reports it.
    once(child, 'close').then(([status, signal]) => {
      if (typeof status === 'number') return status;
      const signals: Record<string, number | undefined> = constants.signals;
      const signum = typeof signal === 'string' ? (signals[signal] ?? 0) : 0;
      return 128 + signum;
    }),
  ]);

  return {code, stdout, stderr};
}

/** The external commands the wrapper needs before it ever looks for node. */
const WRAPPER_TOOLS = ['bash', 'date', 'dirname'];

/**
 * A PATH holding exactly the tools the wrapper needs and no `node`.
 *
 * Filtering `node` out of the real PATH would be wrong on a host where node and
 * bash share a directory (Debian's /usr/bin, most CI images): removing that
 * directory takes bash with it, and the wrapper dies in its shebang instead of
 * reaching the check under test.
 */
export async function pathWithoutNode(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-no-node-'));

  await Promise.all(
    WRAPPER_TOOLS.map(async (tool) => {
      const {stdout} = await execFileAsync('command', ['-v', tool], {
        shell: '/bin/bash',
        encoding: 'utf8',
      });
      await symlink(stdout.trim(), path.join(dir, tool));
    })
  );

  return dir;
}

/**
 * Write an executable `node` stand-in that answers `--version` with `version`,
 * and return the directory holding it — prepend it to PATH to make the wrapper
 * resolve a Node it must reject.
 */
export async function fakeNodeDir(version: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-fake-node-'));
  const bin = path.join(dir, 'node');
  await writeFile(
    bin,
    ['#!/usr/bin/env bash', `printf '%s\\n' '${version}'`, ''].join('\n'),
    'utf8'
  );
  await chmod(bin, 0o755);
  return dir;
}
