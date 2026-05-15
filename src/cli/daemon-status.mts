// CLI handler for `dispatch daemon status`.

import { DispatchError, ExitCode } from "./errors.mts";
import type { CommandHandler } from "./types.mts";
import { ipcRequest, IpcConnectError } from "../daemon/ipc.mts";
import { formatStatusTSV } from "../daemon/status.mts";
import { ensureStateLayout } from "../state/paths.mts";

export const daemonStatus: CommandHandler = async (_parsed, ctx) => {
  const layout = ensureStateLayout({});

  let response;
  try {
    response = await ipcRequest(layout.sockFile, { op: "status" });
  } catch (err) {
    if (err instanceof IpcConnectError) {
      throw new DispatchError(
        ExitCode.PRECONDITION,
        `no dispatch daemon is running (${err.code ?? err.message})`,
        "daemon status",
      );
    }
    throw err;
  }

  if (!response.ok) {
    throw new DispatchError(
      ExitCode.GENERIC,
      `daemon reported error: ${response.error}`,
      "daemon status",
    );
  }

  ctx.stdout.write(`${formatStatusTSV(response.snapshot)}\n`);
};
