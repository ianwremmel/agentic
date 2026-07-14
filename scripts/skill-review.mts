/**
 * Pre-push hook body: run the skill-reviewer agent over skill files changed in
 * the outgoing range and print its feedback. Advisory — the push proceeds
 * regardless, so this always exits 0.
 *
 * Reads the standard pre-push ref lines from stdin:
 *   <local-ref> <local-sha> <remote-ref> <remote-sha>
 *
 * Skip with SKILL_REVIEW=0.
 */

import {execFile, spawn} from 'node:child_process';
import process from 'node:process';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

export const ZERO_SHA = '0'.repeat(40);

export interface PushedRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** Parse pre-push stdin into refs, dropping blank and malformed lines. */
export function parsePushRefs(input: string): PushedRef[] {
  const refs: PushedRef[] = [];
  for (const line of input.split('\n')) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 4) {
      continue;
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields as [
      string,
      string,
      string,
      string,
    ];
    refs.push({localRef, localSha, remoteRef, remoteSha});
  }
  return refs;
}

/** True for markdown inside any plugin's skills tree (SKILL.md, reference.md, …). */
export function isSkillFile(path: string): boolean {
  return /^plugins\/[^/]+\/skills\/.+\.md$/u.test(path);
}

async function git(...args: string[]): Promise<string> {
  const {stdout} = await execFileAsync('git', args);
  return stdout.trim();
}

async function defaultBranch(): Promise<string> {
  try {
    return await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  } catch {
    return 'origin/main';
  }
}

/** Resolve the diff base for one pushed ref; null means "nothing to diff". */
async function diffBase(ref: PushedRef): Promise<string | null> {
  if (ref.localSha === ZERO_SHA) {
    return null; // ref deletion
  }
  if (ref.remoteSha !== ZERO_SHA) {
    return ref.remoteSha;
  }
  // New branch: diff against the default branch's merge-base.
  try {
    return await git('merge-base', await defaultBranch(), ref.localSha);
  } catch {
    return null;
  }
}

async function changedSkillFiles(refs: PushedRef[]): Promise<string[]> {
  const files = new Set<string>();
  for (const ref of refs) {
    // A ref that can't be diffed (e.g. the remote sha isn't in the local
    // object database) skips review for that ref only.
    try {
      const base = await diffBase(ref);
      if (base === null || base === ref.localSha) {
        continue;
      }
      // --diff-filter=d: a deleted file has no contents to review.
      const out = await git(
        'diff',
        '--name-only',
        '--diff-filter=d',
        base,
        ref.localSha
      );
      for (const file of out.split('\n')) {
        if (isSkillFile(file)) {
          files.add(file);
        }
      }
    } catch (error) {
      process.stderr.write(
        `skill-review: cannot diff ${ref.localRef}: ${String(error)}\n`
      );
    }
  }
  return [...files].sort();
}

async function claudeAvailable(): Promise<boolean> {
  try {
    await execFileAsync('claude', ['--version'], {timeout: 15_000});
    return true;
  } catch {
    return false;
  }
}

/** Run the reviewer on one file, streaming its output to our stdout. */
async function review(file: string): Promise<void> {
  process.stdout.write(`\n=== skill-review: ${file} ===\n`);
  const child = spawn(
    'claude',
    [
      '--agent',
      'skill-reviewer',
      '-p',
      `Review ${file} for conciseness, wordiness, and clarity.`,
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      signal: AbortSignal.timeout(300_000),
    }
  );
  await new Promise<void>((resolve) => {
    child.on('error', (error: Error) => {
      process.stderr.write(`skill-review: ${error.message}\n`);
      resolve();
    });
    child.on('exit', () => {
      resolve();
    });
  });
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk as string;
  }
  return input;
}

async function main(): Promise<void> {
  if (process.env.SKILL_REVIEW === '0') {
    return;
  }
  const refs = parsePushRefs(await readStdin());
  const files = await changedSkillFiles(refs);
  if (files.length === 0) {
    return;
  }
  if (!(await claudeAvailable())) {
    process.stderr.write(
      'skill-review: claude unavailable (missing, broken, or hung); ' +
        'skipping skill review\n'
    );
    return;
  }
  process.stdout.write(
    `skill-review: reviewing ${String(files.length)} changed skill file(s); ` +
      'advisory only, the push proceeds either way (SKILL_REVIEW=0 to skip)\n'
  );
  for (const file of files) {
    await review(file);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`skill-review: ${String(error)}\n`);
  }
  process.exitCode = 0;
}
