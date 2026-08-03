import {CommandError} from './command-error.mts';

/**
 * The caller's input was well-formed but describes invalid data: a dependency
 * cycle, an id used as two kinds, an unknown status. Distinct from `UsageError`
 * (a malformed invocation) so a caller can branch on "fix the data" vs "fix the
 * command line".
 */
export class DataError extends CommandError {
  override readonly name: string = 'DataError';
  override readonly exitCode = 4;
}
