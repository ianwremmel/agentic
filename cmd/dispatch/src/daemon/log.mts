import { createWriteStream, mkdirSync, WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface DaemonLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  close(): Promise<void>;
}

interface OpenLogger extends DaemonLogger {
  readonly stream: WriteStream;
}

export function openLogger(path: string, mirrorToStderr = false): DaemonLogger {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: "a" });

  const write = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      pid: process.pid,
      msg,
      ...(fields ?? {}),
    });
    stream.write(line + "\n");
    if (mirrorToStderr) process.stderr.write(line + "\n");
  };

  const logger: OpenLogger = {
    stream,
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    async close() {
      await new Promise<void>((resolve) => stream.end(resolve));
    },
  };
  return logger;
}
