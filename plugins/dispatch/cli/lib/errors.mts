/** Process exit codes the CLI produces. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/**
 * The caller invoked the CLI wrong. Reported to stderr as a plain, agent-facing
 * `error: ...` line (not logfmt) and exits {@link EXIT_USAGE}.
 */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/**
 * `assert` for caller input. `node:assert` is the right tool for invariants the
 * caller cannot violate, but its AssertionError carries a stack trace and reads
 * as a crash; a bad flag is a usage error, so it gets its own assertion.
 */
export function assertUsage(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new UsageError(message);
  }
}
