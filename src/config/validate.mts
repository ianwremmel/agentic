// Hand-rolled validator for the on-disk config file. Returns either a
// validated DispatchConfig or a flat list of error paths/messages
// suitable for stderr output.
//
// Design notes:
//   - No third-party schema library. Keeps the SEA bundle small and
//     avoids a network of indirect deps.
//   - Errors are *collected*, not throw-on-first, so a malformed
//     config surfaces every problem in one go. Issue #23's AC requires
//     a clear stderr message; multiple lines beat hunt-and-peck.
//   - "Unknown key" is a hard error. Typos in this file are silent
//     correctness bugs (e.g. `runner.binnary` would silently pick the
//     default), so we'd rather fail loudly.

import {
  DEFAULT_DAEMON,
  DEFAULT_RUNNER,
  type CIConfig,
  type DispatchConfig,
  type RunnerConfig,
  type DaemonConfig,
  type TrackerConfig,
} from "./schema.mts";

export interface ValidationOk {
  ok: true;
  value: DispatchConfig;
}

export interface ValidationFail {
  ok: false;
  errors: readonly string[];
}

export type ValidationResult = ValidationOk | ValidationFail;

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectKnownKeys(
  obj: Plain,
  path: string,
  known: readonly string[],
  errs: string[],
): void {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) {
      errs.push(`${path}: unknown key "${k}"`);
    }
  }
}

function validateRunner(raw: unknown, errs: string[]): RunnerConfig {
  const path = "runner";
  if (raw === undefined) return DEFAULT_RUNNER;
  if (!isPlainObject(raw)) {
    errs.push(`${path}: must be an object`);
    return DEFAULT_RUNNER;
  }
  expectKnownKeys(
    raw,
    path,
    [
      "binary",
      "extra_args",
      "resume_flag",
      "session_id_capture",
      "permissions",
    ],
    errs,
  );

  let binary = DEFAULT_RUNNER.binary;
  if (raw.binary === undefined) {
    errs.push(`${path}.binary: required`);
  } else if (typeof raw.binary !== "string" || raw.binary.length === 0) {
    errs.push(`${path}.binary: must be a non-empty string`);
  } else {
    binary = raw.binary;
  }

  let extraArgs: readonly string[] = DEFAULT_RUNNER.extraArgs;
  if (raw.extra_args !== undefined) {
    if (
      !Array.isArray(raw.extra_args) ||
      !raw.extra_args.every((v) => typeof v === "string")
    ) {
      errs.push(`${path}.extra_args: must be an array of strings`);
    } else {
      extraArgs = raw.extra_args;
    }
  }

  let resumeFlag = DEFAULT_RUNNER.resumeFlag;
  if (raw.resume_flag !== undefined) {
    if (typeof raw.resume_flag !== "string" || raw.resume_flag.length === 0) {
      errs.push(`${path}.resume_flag: must be a non-empty string`);
    } else {
      resumeFlag = raw.resume_flag;
    }
  }

  let sessionIdCapture: RunnerConfig["sessionIdCapture"] =
    DEFAULT_RUNNER.sessionIdCapture;
  if (raw.session_id_capture !== undefined) {
    if (
      raw.session_id_capture !== "stdout-jsonline" &&
      raw.session_id_capture !== "stderr-jsonline"
    ) {
      errs.push(
        `${path}.session_id_capture: must be one of "stdout-jsonline", "stderr-jsonline"`,
      );
    } else {
      sessionIdCapture = raw.session_id_capture;
    }
  }

  let permissions: string | undefined;
  if (raw.permissions !== undefined) {
    if (typeof raw.permissions !== "string") {
      errs.push(`${path}.permissions: must be a string`);
    } else {
      permissions = raw.permissions;
    }
  }

  return {
    binary,
    extraArgs,
    resumeFlag,
    sessionIdCapture,
    ...(permissions !== undefined ? { permissions } : {}),
  };
}

function validateDaemon(raw: unknown, errs: string[]): DaemonConfig {
  const path = "daemon";
  if (raw === undefined) return DEFAULT_DAEMON;
  if (!isPlainObject(raw)) {
    errs.push(`${path}: must be an object`);
    return DEFAULT_DAEMON;
  }
  expectKnownKeys(
    raw,
    path,
    ["heartbeat_interval_seconds", "max_concurrent_runners"],
    errs,
  );

  let heartbeatIntervalSeconds = DEFAULT_DAEMON.heartbeatIntervalSeconds;
  if (raw.heartbeat_interval_seconds !== undefined) {
    if (
      typeof raw.heartbeat_interval_seconds !== "number" ||
      !Number.isFinite(raw.heartbeat_interval_seconds) ||
      raw.heartbeat_interval_seconds <= 0
    ) {
      errs.push(
        `${path}.heartbeat_interval_seconds: must be a positive number`,
      );
    } else {
      heartbeatIntervalSeconds = raw.heartbeat_interval_seconds;
    }
  }

  let maxConcurrentRunners = DEFAULT_DAEMON.maxConcurrentRunners;
  if (raw.max_concurrent_runners !== undefined) {
    if (
      typeof raw.max_concurrent_runners !== "number" ||
      !Number.isInteger(raw.max_concurrent_runners) ||
      raw.max_concurrent_runners < 1
    ) {
      errs.push(`${path}.max_concurrent_runners: must be a positive integer`);
    } else {
      maxConcurrentRunners = raw.max_concurrent_runners;
    }
  }

  return { heartbeatIntervalSeconds, maxConcurrentRunners };
}

function validateTrackers(
  raw: unknown,
  errs: string[],
): Record<string, TrackerConfig> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    errs.push(`tracker: must be an object keyed by label`);
    return {};
  }
  const out: Record<string, TrackerConfig> = {};
  for (const [label, entryRaw] of Object.entries(raw)) {
    const p = `tracker.${label}`;
    if (!isPlainObject(entryRaw)) {
      errs.push(`${p}: must be an object`);
      continue;
    }
    expectKnownKeys(entryRaw, p, ["kind", "token", "workspace_id"], errs);
    const kind = entryRaw.kind;
    const token = entryRaw.token;
    if (typeof token !== "string" || token.length === 0) {
      errs.push(`${p}.token: must be a non-empty string`);
      continue;
    }
    if (kind === "linear") {
      const ws = entryRaw.workspace_id;
      if (ws !== undefined && typeof ws !== "string") {
        errs.push(`${p}.workspace_id: must be a string`);
        continue;
      }
      out[label] = {
        kind: "linear",
        token,
        ...(typeof ws === "string" ? { workspaceId: ws } : {}),
      };
    } else if (kind === "asana") {
      const ws = entryRaw.workspace_id;
      if (typeof ws !== "string" || ws.length === 0) {
        errs.push(`${p}.workspace_id: required for asana trackers`);
        continue;
      }
      out[label] = { kind: "asana", token, workspaceId: ws };
    } else {
      errs.push(`${p}.kind: must be one of "linear", "asana"`);
    }
  }
  return out;
}

function validateCi(raw: unknown, errs: string[]): Record<string, CIConfig> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    errs.push(`ci: must be an object keyed by label`);
    return {};
  }
  const out: Record<string, CIConfig> = {};
  for (const [label, entryRaw] of Object.entries(raw)) {
    const p = `ci.${label}`;
    if (!isPlainObject(entryRaw)) {
      errs.push(`${p}: must be an object`);
      continue;
    }
    expectKnownKeys(entryRaw, p, ["kind", "token", "organization"], errs);
    const kind = entryRaw.kind;
    if (kind === "buildkite") {
      const token = entryRaw.token;
      if (typeof token !== "string" || token.length === 0) {
        errs.push(`${p}.token: must be a non-empty string`);
        continue;
      }
      const org = entryRaw.organization;
      if (org !== undefined && typeof org !== "string") {
        errs.push(`${p}.organization: must be a string`);
        continue;
      }
      out[label] = {
        kind: "buildkite",
        token,
        ...(typeof org === "string" ? { organization: org } : {}),
      };
    } else if (kind === "github-actions") {
      const token = entryRaw.token;
      if (token !== undefined && typeof token !== "string") {
        errs.push(`${p}.token: must be a string`);
        continue;
      }
      out[label] = {
        kind: "github-actions",
        ...(typeof token === "string" ? { token } : {}),
      };
    } else {
      errs.push(`${p}.kind: must be one of "buildkite", "github-actions"`);
    }
  }
  return out;
}

export function validate(raw: unknown): ValidationResult {
  const errs: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["config root: must be a JSON object"] };
  }
  expectKnownKeys(raw, "config", ["runner", "daemon", "tracker", "ci"], errs);

  const runner = validateRunner(raw.runner, errs);
  const daemon = validateDaemon(raw.daemon, errs);
  const trackers = validateTrackers(raw.tracker, errs);
  const ci = validateCi(raw.ci, errs);

  if (errs.length > 0) return { ok: false, errors: errs };
  return {
    ok: true,
    value: { runner, daemon, trackers, ci },
  };
}
