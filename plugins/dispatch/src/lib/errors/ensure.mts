import type {DispatchError} from './dispatch-error.mts';
import {UsageError} from './usage-error.mts';

/** `assert` for caller input: a failed check is a usage error, not a crash. */
export function assertUsage(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new UsageError(message);
  }
}

/** `assert` against a taxonomy error, built lazily so the passing path never constructs it. */
export function ensure(
  condition: unknown,
  error: () => DispatchError
): asserts condition {
  if (!condition) {
    throw error();
  }
}
