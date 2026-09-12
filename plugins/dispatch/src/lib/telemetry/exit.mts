import {constants} from 'node:os';
import type {Writable} from 'node:stream';

import {forgiving} from './stream.mts';
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
  // The fatal handler reports through this stream, and one of the things it
  // reports is a broken pipe. An unguarded `error` on the stream would be an
  // uncaught exception raised from inside the uncaught-exception handler.
  const out = forgiving(stream);
  const installed: {off: () => void}[] = [];

  for (const signal of SIGNALS) {
    const handler = (): void => {
      void (async (): Promise<void> => {
        try {
          // `shutdown` belongs to the caller: it can reject, and it can throw
          // before it ever returns a promise. Both have to stay inside this
          // try. An escape would reach the fatal handler below, which would
          // report a crash and exit 1 instead of re-raising — an orderly
          // signal turned into a spurious bug report.
          await telemetry.shutdown();
        } catch {
          // A flush that failed has nowhere left to be reported.
        }
        process.removeListener(signal, handler);
        try {
          process.kill(process.pid, signal);
        } catch {
          // Re-raising is the only way to exit the way the caller asked, so
          // if it fails the best that is left is the code it would have
          // produced.
          process.exit(128 + constants.signals[signal]);
        }
      })();
    };
    process.on(signal, handler);
    installed.push({off: () => void process.removeListener(signal, handler)});
  }

  // Reporting a crash must not be able to cause one. Writing to a broken
  // stream raises `error`, and a flush can throw — either would re-enter
  // these handlers, report that, and do it again. The latch means the second
  // fatal event finds the first already on its way out.
  let dying = false;
  for (const event of FATAL) {
    const handler = (reason: unknown): void => {
      if (dying) return;
      dying = true;
      void (async (): Promise<void> => {
        try {
          out.write(
            `${event}: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`
          );
          await telemetry.shutdown();
        } catch {
          // There is no third place to report a failure to report a failure.
        }
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
