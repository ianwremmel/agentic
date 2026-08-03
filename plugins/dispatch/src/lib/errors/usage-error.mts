import {CommandError} from './command-error.mts';

/** The caller invoked the command wrong: an unknown flag, a missing argument, a bad choice. */
export class UsageError extends CommandError {
  override readonly name: string = 'UsageError';
  override readonly exitCode = 2;
}
