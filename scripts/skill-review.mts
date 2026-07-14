/**
 * Pre-push hook body: run the skill-reviewer agent over skill files changed in
 * the outgoing range. A blocking verdict — a must-fix finding, or a file the
 * reviewer judges more than ~25% cuttable — exits 1 and blocks the push until
 * the pusher acts on the report; advisory findings print but never block.
 * Infrastructure failures (claude missing or crashing) fail open with a
 * warning — there is no report to act on. SKILL_REVIEW=0 is the emergency
 * bypass.
 *
 * Reads the standard pre-push ref lines from stdin:
 *   <local-ref> <local-sha> <remote-ref> <remote-sha>
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

/**
 * Extract the reviewer's verdict from its report. The agent contract requires
 * `VERDICT: pass` (possibly with advisory findings above it) or
 * `VERDICT: block` as the last non-empty line; a report that breaks the
 * contract counts as blocking so the gate fails closed.
 */
export function verdictFrom(report: string): 'pass' | 'block' {
  const lines = report.split('\n').filter((line) => line.trim() !== '');
  return lines.at(-1)?.trim() === 'VERDICT: pass' ? 'pass' : 'block';
}

/**
 * Run the reviewer on one file, streaming its report to stdout while
 * capturing it. 'error' means the reviewer itself failed — no report exists.
 */
async function review(file: string): Promise<'pass' | 'block' | 'error'> {
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
      stdio: ['ignore', 'pipe', 'inherit'],
      signal: AbortSignal.timeout(300_000),
    }
  );
  let report = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    report += chunk;
    process.stdout.write(chunk);
  });
  return new Promise((resolve) => {
    child.on('error', (error: Error) => {
      process.stderr.write(`skill-review: ${error.message}\n`);
      resolve('error');
    });
    child.on('exit', (code) => {
      resolve(code === 0 ? verdictFrom(report) : 'error');
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

/** True when the push may proceed. */
async function main(): Promise<boolean> {
  if (process.env.SKILL_REVIEW === '0') {
    return true;
  }
  const refs = parsePushRefs(await readStdin());
  const files = await changedSkillFiles(refs);
  if (files.length === 0) {
    return true;
  }
  if (!(await claudeAvailable())) {
    process.stderr.write(
      'skill-review: claude unavailable (missing, broken, or hung); ' +
        'skipping skill review\n'
    );
    return true;
  }
  process.stdout.write(
    `skill-review: reviewing ${String(files.length)} changed skill file(s)\n`
  );
  const failed: string[] = [];
  for (const file of files) {
    if ((await review(file)) === 'block') {
      failed.push(file);
    }
  }
  if (failed.length > 0) {
    process.stderr.write(
      '\nskill-review: must-fix findings above block the push. Act on the ' +
        `report (${failed.join(', ')}), commit, and push again. ` +
        'Emergency bypass: SKILL_REVIEW=0 git push\n'
    );
    return false;
  }
  return true;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exitCode = (await main()) ? 0 : 1;
  } catch (error) {
    // A crash in the hook itself is an infrastructure failure, not a review
    // verdict — fail open rather than strand the push.
    process.stderr.write(`skill-review: ${String(error)}\n`);
    process.exitCode = 0;
  }
}
