/**
 * A JSON-RPC protocol failure (bad method, malformed request, unknown tool).
 * The server loop renders it into an `error` response. Distinct from a tool's
 * own failure, which is a successful result carrying `isError: true`.
 */
export class JsonRpcError extends Error {
  override readonly name = 'JsonRpcError';
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
