import {assertUsage} from '../errors/index.mts';

/**
 * How many PRs one repo may have open at once when nothing overrides it. An
 * open PR holds third-party resources — preview stacks, cloud quota — for as
 * long as it stays open, which no claim-based budget bounds: a worker releases
 * its claim the moment it yields to a wait.
 */
export const DEFAULT_MAX_OPEN_PRS = 5;

/**
 * How many of one repo's PRs may have CI running at once when nothing
 * overrides it. Deliberately coarse: a PR with twenty parallel jobs counts as
 * one, because the failure being prevented is "too much in flight at once"
 * rather than exact job accounting.
 */
export const DEFAULT_MAX_IN_FLIGHT_BUILDS = 3;

export const REPO_CAPS = ['open-prs', 'in-flight-builds'] as const;
export type RepoCap = (typeof REPO_CAPS)[number];

/** Both caps, each a global default plus per-repo overrides. */
export interface RepoCapPolicy {
  readonly openPrs: number;
  readonly inFlightBuilds: number;
  readonly openPrsByRepo: Readonly<Record<string, number>>;
  readonly inFlightBuildsByRepo: Readonly<Record<string, number>>;
}

export const DEFAULT_REPO_CAPS: RepoCapPolicy = Object.freeze({
  openPrs: DEFAULT_MAX_OPEN_PRS,
  inFlightBuilds: DEFAULT_MAX_IN_FLIGHT_BUILDS,
  openPrsByRepo: Object.freeze({}),
  inFlightBuildsByRepo: Object.freeze({}),
});

/** The limit in force for one repo: its override, else the global default. */
export function limitFor(
  policy: RepoCapPolicy,
  repo: string,
  cap: RepoCap
): number {
  return cap === 'open-prs'
    ? (policy.openPrsByRepo[repo] ?? policy.openPrs)
    : (policy.inFlightBuildsByRepo[repo] ?? policy.inFlightBuilds);
}

/**
 * A cap must be a whole number of 0 or more. A negative one is never reached
 * from below, so it would refuse every PR item forever — and the build cap's
 * only promise is that it drains without an agent.
 */
export function assertCapLimit(value: number, option: string): number {
  assertUsage(
    Number.isInteger(value) && value >= 0,
    `option ${option} expects a whole number of 0 or more, got "${String(value)}"`
  );
  return value;
}

/**
 * Parse an override list — `owner/repo=2,owner/other=0` — into a limit per
 * repo. The option name rides along so a malformed entry names the flag its
 * writer has to fix.
 */
export function parseRepoLimits(
  spec: string,
  option: string
): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const part of spec.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const split = entry.indexOf('=');
    assertUsage(
      split > 0,
      `option ${option} expects "owner/repo=<number>" entries, got "${entry}"`
    );
    const repo = entry.slice(0, split).trim();
    const value = entry.slice(split + 1).trim();
    assertUsage(
      /^[^/\s]+\/[^/\s]+$/u.test(repo),
      `option ${option} expects an owner/repo before "=", got "${repo}"`
    );
    // An explicit digits-only match, because `Number('')` is 0: an entry that
    // forgot its limit would otherwise read as a cap of zero and wedge the
    // repo it names.
    assertUsage(
      /^\d+$/u.test(value),
      `option ${option} expects a whole number of 0 or more for ${repo}, got "${value}"`
    );
    limits[repo] = Number(value);
  }
  return limits;
}
