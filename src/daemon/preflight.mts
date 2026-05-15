// Required-CLI preflight per
// `docs/spec/03-cli/01-daemon/02-normative.md` §Lifecycle §Start.
//
// The daemon MUST verify that every required CLI is installed AND
// authenticated before doing anything else. Any failure is a fatal
// startup error (exit code 4 — PRECONDITION).
//
// Required CLIs (canonical list):
//   - the configured runner binary (e.g. `claude`)
//   - `git`
//   - `gh`
//   - the configured CI provider CLI (e.g. `bk` if Buildkite enabled)
//   - the configured tracker CLI (if applicable)
//
// Each CLI is probed by running a small command (typically
// `--version` for presence, or a provider-specific `auth status`
// for authentication). Probes are injected so unit tests don't have
// to shell out and so the real entrypoint can pick the right probes
// from configuration.

export interface CliProbe {
  /** Display name used in error messages, e.g. "git" or "gh auth". */
  name: string;
  /** Argv to execute. argv[0] is the binary, the rest are arguments. */
  argv: readonly string[];
  /**
   * What the probe asserts. `present` means the binary is installed;
   * `authenticated` means the binary is installed AND can talk to its
   * remote service. The distinction is for error reporting only —
   * both kinds of failure abort startup.
   */
  asserts: "present" | "authenticated";
}

export interface ProbeOutcome {
  /** 0 means success. Non-zero or -1 (spawn failed) is a failure. */
  exitCode: number;
  /** When the binary couldn't be located, set this to a friendly note. */
  reason?: string;
}

/** Injected runner. Returns synchronously-resolved `ProbeOutcome`. */
export type ProbeRunner = (probe: CliProbe) => Promise<ProbeOutcome>;

export interface PreflightFailure {
  probe: CliProbe;
  exitCode: number;
  reason: string;
}

export interface PreflightReport {
  ok: boolean;
  failures: readonly PreflightFailure[];
}

/**
 * Run every probe; collect failures. Probes run in declaration order
 * (sequential, not parallel) so the operator sees a deterministic
 * failure trace even when several CLIs are missing.
 */
export async function verifyRequiredClis(
  probes: readonly CliProbe[],
  run: ProbeRunner,
): Promise<PreflightReport> {
  const failures: PreflightFailure[] = [];
  for (const probe of probes) {
    const out = await run(probe);
    if (out.exitCode !== 0) {
      failures.push({
        probe,
        exitCode: out.exitCode,
        reason:
          out.reason ??
          (probe.asserts === "present"
            ? `${probe.name} is not installed or returned non-zero`
            : `${probe.name} is not authenticated`),
      });
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Build the minimal canonical probe list. Callers may extend with
 * config-derived probes (e.g. a tracker CLI) before passing the list
 * to `verifyRequiredClis`.
 *
 * The runner binary, CI provider, and tracker probes are all driven
 * from the daemon's config. Only `git` and `gh` are unconditional.
 */
export function buildBaseProbes(opts: {
  runnerBin: string;
  ciCli?: string | null;
  trackerCli?: string | null;
}): CliProbe[] {
  const probes: CliProbe[] = [
    { name: opts.runnerBin, argv: [opts.runnerBin, "--version"], asserts: "present" },
    { name: "git", argv: ["git", "--version"], asserts: "present" },
    { name: "gh", argv: ["gh", "--version"], asserts: "present" },
    { name: "gh auth", argv: ["gh", "auth", "status"], asserts: "authenticated" },
  ];
  if (opts.ciCli) {
    probes.push({
      name: opts.ciCli,
      argv: [opts.ciCli, "--version"],
      asserts: "present",
    });
  }
  if (opts.trackerCli) {
    probes.push({
      name: opts.trackerCli,
      argv: [opts.trackerCli, "--version"],
      asserts: "present",
    });
  }
  return probes;
}

/**
 * Format a preflight failure list for stderr. The daemon prints this
 * verbatim before exiting with code 4.
 */
export function formatFailures(failures: readonly PreflightFailure[]): string {
  return failures
    .map(
      (f) =>
        `  - ${f.probe.name} (${f.probe.asserts}): exit ${f.exitCode}: ${f.reason}`,
    )
    .join("\n");
}
