import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {access, chmod, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** The bash wrapper under test — the same path skills invoke. */
export const DISPATCH_BIN = path.join(
  REPO_ROOT,
  'plugins',
  'dispatch',
  'bin',
  'dispatch',
);

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
  {env = {}}: DispatchOptions = {},
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

/**
 * The caller's PATH with every directory that holds a `node` executable removed.
 * Which directories those are varies by host (fnm, nvm, /usr/bin, a CI toolcache),
 * so they are discovered rather than assumed.
 */
export async function pathWithoutNode(): Promise<string> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const kept = await Promise.all(
    dirs.map(async (dir) => {
      try {
        await access(path.join(dir, 'node'), constants.X_OK);
        return undefined;
      } catch {
        return dir;
      }
    }),
  );
  return kept.filter((dir) => dir !== undefined).join(path.delimiter);
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
    'utf8',
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
