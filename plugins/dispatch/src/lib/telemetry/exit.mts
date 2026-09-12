import type {Writable} from 'node:stream';

import type {Telemetry} from './telemetry.mts';

/** The signals a supervisor stops a process with. */
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** The two ways a process dies without unwinding anything. */
const FATAL = ['uncaughtException', 'unhandledRejection'] as const;

/**
 * Flush telemetry on the exit paths no `finally` sees, then let each one end
 * the process the way it would have.
 *
 * A `finally` covers a command that returns and a command that throws where
 * something awaits it. It does not cover a signal, which kills the process
 * outright — `dispatch mcp` takes a SIGTERM on every plugin reload, so the
 * records it was holding are lost each time. Nor does it cover a throw from a
 * callback nothing awaits, which is how a long-running server dies and exactly
 * the death its telemetry is there to explain.
 *
 * Each handler is installed for its own reason:
 *
 * A signal handler suppresses the default kill, so this one re-raises. With
 * its own listener gone, and no other listener registered, there is nothing
 * left to catch the second signal and the process dies as asked, with the
 * conventional 128-plus-signal code. Where something else has registered a
 * listener for that signal, the re-raise reaches it and that owner decides —
 * this does not override it.
 *
 * A fatal handler suppresses the default crash, so this one reports the error
 * the way Node would and exits 1, which is the code Node would have used.
 *
 * Nothing else in the process gains a shutdown path from any of this. The MCP
 * server's own `finally` did not run on a signal before and still does not.
 *
 * Returns the uninstaller. Call it after the flush, not before: a signal
 * arriving during a normal shutdown would otherwise kill the process
 * mid-export, which is the case these handlers exist for.
 */
export function flushOnExit(
  telemetry: Telemetry,
  stream: Writable
): () => void {
  const installed: {off: () => void}[] = [];

  for (const signal of SIGNALS) {
    const handler = (): void => {
      void (async (): Promise<void> => {
        // A failed flush must not become an unhandled rejection: that would
        // end the process here instead of re-raising, and with the wrong code.
        await telemetry.shutdown().catch(() => undefined);
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      })();
    };
    process.on(signal, handler);
    installed.push({off: () => void process.removeListener(signal, handler)});
  }

  for (const event of FATAL) {
    const handler = (reason: unknown): void => {
      void (async (): Promise<void> => {
        stream.write(
          `${event}: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`
        );
        await telemetry.shutdown().catch(() => undefined);
        process.exit(1);
      })();
    };
    process.on(event, handler);
    installed.push({off: () => void process.removeListener(event, handler)});
  }

  return (): void => {
    for (const {off} of installed) off();
  };
}
