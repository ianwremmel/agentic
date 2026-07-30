import {DispatchError} from './dispatch-error.mts';

/**
 * A failure from validating, discovering, or running a command. The CLI returns
 * its `exitCode`; the MCP transport renders it as an `isError` tool result. This
 * is the base for the command-facing taxonomy — a transport-protocol failure
 * (the MCP server's `JsonRpcError`) extends `DispatchError` directly instead, as
 * a sibling of this, because it carries a protocol code rather than an exit code.
 */
export class CommandError extends DispatchError {
  override readonly name: string = 'CommandError';
  readonly exitCode: number = 1;
}
