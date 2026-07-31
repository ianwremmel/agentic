import {parseArgs, type ParseArgsConfig} from 'node:util';

import {UsageError} from './errors.mts';

/**
 * `parseArgs`, with bad input surfaced as a usage error. `parseArgs` reports an
 * unknown flag or a missing option value by throwing `ERR_PARSE_ARGS_*`, which
 * would otherwise reach the caller as a crash with a stack trace. Anything else
 * (a malformed config, i.e. our bug) propagates untouched.
 */
export function parseArgsOrUsage<T extends ParseArgsConfig>(
  config: T
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new Error('parseArgs threw a non-Error value', {cause: error});
    }

    const code: unknown = 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
      throw new UsageError(error.message, {cause: error});
    }

    throw error;
  }
}
