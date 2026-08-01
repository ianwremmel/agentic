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
 *
 * Files are reviewed concurrently. git opens the connection to the remote
 * before it runs this hook and holds it idle until the hook returns, so hook
 * wall-clock is charged against the remote's idle timeout: GitHub closes the
 * connection somewhere under seven minutes, and git then dies of SIGPIPE
 * writing the pack — whatever the verdict was. One review takes ~70-90 s, so
 * reviewing serially put any push touching five or more skill files past that
 * limit and made the gate unpassable by construction.
 */

import {execFile, spawn} from 'node:child_process';
import process from 'node:process';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Concurrent reviews. Each one is a `claude` process, so this bounds load on a
 * change that touches many skill files while keeping the common case (a
 * handful) to a single wave.
 */
const REVIEW_CONCURRENCY = 8;

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
 * Run the reviewer on one file. The report is buffered rather than streamed:
 * reviews run concurrently, and interleaved chunks would shred every report.
 * It is written in one call when the reviewer finishes, so each file's block
 * lands whole. 'error' means the reviewer itself failed — no report exists.
 */
async function review(file: string): Promise<'pass' | 'block' | 'error'> {
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
  });
  return new Promise((resolve) => {
    child.on('error', (error: Error) => {
      process.stderr.write(`skill-review: ${file}: ${error.message}\n`);
      resolve('error');
    });
    // 'close', not 'exit': 'exit' can fire before stdout is fully consumed,
    // truncating the report and turning a clean verdict into a false block.
    child.on('close', (code) => {
      process.stdout.write(`\n=== skill-review: ${file} ===\n${report}`);
      resolve(code === 0 ? verdictFrom(report) : 'error');
    });
  });
}

/**
 * Map `fn` over `items` with at most `limit` in flight, returning results in
 * input order regardless of completion order. Workers pull from a shared
 * cursor rather than running fixed batches, so a slow item never idles the
 * others behind a barrier.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let index = cursor++; index < items.length; index = cursor++) {
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, worker)
  );
  return results;
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
    `skill-review: reviewing ${String(files.length)} changed skill file(s), ` +
      `up to ${String(REVIEW_CONCURRENCY)} at a time\n`
  );
  const verdicts = await mapWithConcurrency(files, REVIEW_CONCURRENCY, review);
  const failed = files.filter((_, index) => verdicts[index] === 'block');
  if (failed.length > 0) {
    process.stderr.write(
      '\nskill-review: blocking verdict(s) above stop the push. Act on the ' +
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
