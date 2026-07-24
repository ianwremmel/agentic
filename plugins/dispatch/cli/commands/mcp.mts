import {parseArgsOrUsage} from '../lib/args.mts';
import type {Command} from '../lib/command.mts';
import {isPeerGone} from '../lib/io.mts';
import {serve} from '../lib/mcp/server.mts';
import {pluginVersion} from '../lib/plugin-version.mts';
import {group} from '../lib/subcommand.mts';

/** The signals a runner uses to take a subprocess down; both mean "stop, cleanly". */
const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

const server: Command = {
  name: 'mcp',
  summary: 'Run the channel server on stdin/stdout.',
  usage: [
    'dispatch mcp',
    '',
    'Speaks newline-delimited JSON-RPC on stdin/stdout, so it is started by the',
    'session runner as a subprocess, not from a terminal. It runs until the',
    'runner closes stdin or signals it, and exposes no tools: a session steers',
    'it by writing the graph with ordinary dispatch commands.',
  ].join('\n'),

  async run(argv, {stdin, stdout, stderr, log}) {
    parseArgsOrUsage({
      args: argv,
      options: {},
      allowPositionals: false,
      strict: true,
    });

    // Read before serving: reporting a version we could not read would be a
    // lie told during the handshake, and the manifest is only missing when the
    // install is broken.
    const version = await pluginVersion();

    // The runner can take the log stream down with the rest of the session, and
    // an unlistened 'error' event on it would end the process as a crash long
    // after there was anything left to report. The listener outlives this
    // command deliberately: the last writes to stderr happen after it returns,
    // as the CLI logs the command out.
    stderr.on('error', () => undefined);

    const controller = new AbortController();
    const stop = (signal: NodeJS.Signals): void => {
      // A signal handler cannot await, and aborting is what actually has to
      // happen — a stderr that has already gone must not turn the shutdown into
      // an unhandled rejection.
      log.info('stopping on signal', {signal}).catch(() => undefined);
      controller.abort();
    };
    for (const signal of STOP_SIGNALS) {
      process.on(signal, stop);
    }

    try {
      await serve({
        input: stdin,
        output: stdout,
        log,
        version,
        signal: controller.signal,
      });
    } catch (error) {
      // The runner tearing down its pipes — stderr included, so even the log
      // line about it fails — is how a session ends. There is nobody left to
      // report to, and reporting it as a crash would make every clean shutdown
      // look like one.
      if (!isPeerGone(error)) throw error;
    } finally {
      for (const signal of STOP_SIGNALS) {
        process.off(signal, stop);
      }
    }
  },
};

export const mcp = group({
  name: 'mcp',
  summary: 'Run the channel server the session runner spawns over stdio.',
  children: [],
  fallback: server,
});
