import type {AbstractCommand} from './abstract-command.mts';

export interface ResolvedTransports {
  readonly cli: boolean;
  readonly mcp: boolean;
}

/**
 * A command's transport availability with defaults filled in, so gating code
 * reads definite booleans instead of an optional partial. An unstated
 * transport is available.
 */
export function resolveTransports(
  command: AbstractCommand
): ResolvedTransports {
  return {cli: true, mcp: true, ...command.transports};
}
