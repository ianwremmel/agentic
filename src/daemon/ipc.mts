// Daemon IPC: a tiny NDJSON-over-unix-domain-socket RPC channel.
//
// Used by `dispatch daemon status` (and future readonly commands) to
// query live daemon state without touching the on-disk task store
// concurrently with the daemon.
//
// Protocol (intentionally minimalist):
//
//   client → server : single line, JSON object terminated by "\n"
//                      e.g. {"op":"status"}
//   server → client : single line, JSON object terminated by "\n"
//                      e.g. {"ok":true,"snapshot":{...}}
//                      or   {"ok":false,"error":"..."}
//
// After the server emits its response it closes the connection. This
// is deliberately one-shot: no framing complexity, no auth, and no
// streaming. Adding a new op = adding a new branch in the handler.
//
// All I/O is in `node:net`; the spool of in-flight connections is
// tracked so `close()` can drain on shutdown.

import { createServer, createConnection, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";

import type { DaemonStatusSnapshot } from "./status.mts";

/** Request shape sent by the client. */
export type IpcRequest = { op: "status" };

/** Response shape sent by the server. */
export type IpcResponse =
  | { ok: true; op: "status"; snapshot: DaemonStatusSnapshot }
  | { ok: false; error: string };

export interface IpcServerHandle {
  /** Stop accepting new connections; resolves when fully closed. */
  close(): Promise<void>;
}

export interface IpcServerDeps {
  sockFile: string;
  /** Called for every well-formed status request. */
  getStatus: () => DaemonStatusSnapshot | Promise<DaemonStatusSnapshot>;
}

/**
 * Start the IPC server. Removes any stale socket file first.
 * Returns once the server is listening.
 */
export async function startIpcServer(deps: IpcServerDeps): Promise<IpcServerHandle> {
  // Best-effort: unlink any leftover socket from a previous run.
  // `daemon start` already verifies we hold the PID lock, so this is
  // safe — no other live daemon is using this path.
  await unlink(deps.sockFile).catch(() => undefined);

  const server: Server = createServer((sock: Socket) => {
    handleConnection(sock, deps.getStatus).catch(() => {
      // The connection-level handler already writes an error response
      // when feasible; if it failed, we just tear the socket down.
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.sockFile, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(deps.sockFile).catch(() => undefined);
    },
  };
}

async function handleConnection(
  sock: Socket,
  getStatus: IpcServerDeps["getStatus"],
): Promise<void> {
  // Buffer until newline; per protocol the client sends exactly one
  // line. Anything past the first newline is ignored.
  let buf = "";
  const line = await new Promise<string>((resolve, reject) => {
    sock.setEncoding("utf8");
    const onData = (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        sock.off("data", onData);
        sock.off("error", onError);
        sock.off("end", onEnd);
        resolve(buf.slice(0, idx));
      }
    };
    const onError = (err: Error) => {
      sock.off("data", onData);
      sock.off("end", onEnd);
      reject(err);
    };
    const onEnd = () => {
      sock.off("data", onData);
      sock.off("error", onError);
      // Client closed before sending newline → empty request.
      resolve(buf);
    };
    sock.on("data", onData);
    sock.on("error", onError);
    sock.on("end", onEnd);
  });

  let response: IpcResponse;
  try {
    const req = JSON.parse(line) as IpcRequest;
    if (req.op === "status") {
      const snapshot = await getStatus();
      response = { ok: true, op: "status", snapshot };
    } else {
      response = { ok: false, error: `unknown op: ${String((req as { op: unknown }).op)}` };
    }
  } catch (err) {
    response = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await new Promise<void>((resolve, reject) => {
    sock.end(`${JSON.stringify(response)}\n`, (err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Issue a single request to the daemon IPC socket and return its
 * response. Throws a {@link IpcConnectError} on socket-level failure
 * so callers can map ENOENT/ECONNREFUSED to "daemon not running".
 */
export async function ipcRequest(
  sockFile: string,
  req: IpcRequest,
): Promise<IpcResponse> {
  return new Promise<IpcResponse>((resolve, reject) => {
    const sock = createConnection(sockFile);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", (err) => {
      reject(new IpcConnectError(err));
    });
    sock.on("connect", () => {
      sock.write(`${JSON.stringify(req)}\n`);
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
    });
    sock.on("end", () => {
      const line = buf.replace(/\n$/, "");
      try {
        resolve(JSON.parse(line) as IpcResponse);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Wraps a low-level socket error so callers can detect it cleanly. */
export class IpcConnectError extends Error {
  readonly cause: Error;
  readonly code: string | undefined;
  constructor(cause: Error) {
    super(`dispatch IPC: ${cause.message}`);
    this.name = "IpcConnectError";
    this.cause = cause;
    this.code = (cause as NodeJS.ErrnoException).code;
  }
}
