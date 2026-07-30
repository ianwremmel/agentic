import {DispatchError} from '../errors/index.mts';

/**
 * A JSON-RPC protocol failure (bad method, malformed request, unknown tool).
 * The server loop renders it into an `error` response. A sibling of
 * `CommandError` under `DispatchError`: it carries a protocol `code` rather than
 * an exit code, and unlike a command failure — which becomes a successful result
 * with `isError: true` — it is a wire-level fault, not a tool result.
 */
export class JsonRpcError extends DispatchError {
  override readonly name = 'JsonRpcError';
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
