import {execFile} from 'node:child_process';
import {chmod, mkdtemp, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

/** The bash wrapper under test — the same path skills invoke. */
export const DISPATCH_BIN = path.join(import.meta.dirname, 'bin', 'dispatch');

export interface DispatchResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DispatchOptions {
  /** Merged over a minimal base env. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Run the wrapper the way a skill would, and report what a caller sees: exit
 * code, stdout, stderr. A non-zero exit is a result, not a test failure.
 */
export async function runDispatch(
  args: readonly string[],
  {env = {}}: DispatchOptions = {}
): Promise<DispatchResult> {
  try {
    const {stdout, stderr} = await execFileAsync(DISPATCH_BIN, [...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...env,
      },
      encoding: 'utf8',
    });
    return {code: 0, stdout, stderr};
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
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

const ESCAPES: Record<string, string> = {n: '\n', r: '\r'};

/** Parse a logfmt line into its fields, unescaping quoted values. */
export function parseLogfmt(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern =
    /(?<key>[^\s=]+)=(?:"(?<quoted>(?:\\.|[^"\\])*)"|(?<bare>[^\s]*))/gu;

  for (const match of line.matchAll(pattern)) {
    const {key, quoted, bare} = match.groups as {
      key: string;
      quoted?: string;
      bare?: string;
    };
    fields[key] =
      quoted === undefined
        ? (bare ?? '')
        : quoted.replace(/\\(.)/gu, (_, char: string) => ESCAPES[char] ?? char);
  }

  return fields;
}

/** The logfmt records the CLI wrote to stderr, in order. */
export function logRecords(stderr: string): Record<string, string>[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('ts='))
    .map(parseLogfmt);
}
