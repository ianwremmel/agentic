import {diag} from '@opentelemetry/api';

/** Any non-empty endpoint means a collector, per the OTLP exporter spec. */
const ENDPOINTS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

/** The per-signal exporter selectors `NodeSDK` reads from the environment. */
export const SELECTORS = {
  logs: 'OTEL_LOGS_EXPORTER',
  metrics: 'OTEL_METRICS_EXPORTER',
  traces: 'OTEL_TRACES_EXPORTER',
} as const;

export type Signal = keyof typeof SELECTORS;

const SIGNALS = ['logs', 'metrics', 'traces'] as const;

/** `stream`: this module's stderr exporter. `sdk`: NodeSDK's. `off`: neither. */
export type Destination = 'off' | 'sdk' | 'stream';

/** Trimmed, because the SDK's own environment reader trims. */
export function hasOtlpEndpoint(env: NodeJS.ProcessEnv): boolean {
  return ENDPOINTS.some((name) => (env[name] ?? '').trim() !== '');
}

/**
 * One signal's exporter selector. The single parse for both routing and
 * `warnOnConsolePairing`, so the two cannot disagree about what was asked for.
 */
function readSelectors(env: NodeJS.ProcessEnv, signal: Signal): string[] {
  return (env[SELECTORS[signal]] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
}

/**
 * Route one signal. Unset means stderr, or the collector when one is named.
 *
 * `console` asks for output a human reads, which OTel puts on stdout, so this
 * module serves it from stderr instead. It can only do that by naming a
 * processor, and naming one turns off `NodeSDK`'s environment handling for the
 * whole signal — so a selector pairing `console` with a real exporter cannot
 * have both, and the real one wins.
 */
export function resolveDestination(
  env: NodeJS.ProcessEnv,
  signal: Signal
): Destination {
  const names = readSelectors(env, signal);
  if (names.length === 0) return hasOtlpEndpoint(env) ? 'sdk' : 'stream';
  if (names.every((name) => name === 'none')) return 'off';
  if (!names.includes('console')) return 'sdk';
  return names.every((name) => name === 'console' || name === 'none')
    ? 'stream'
    : 'sdk';
}

/**
 * Warn about each `console` a real exporter displaces, rather than dropping it
 * silently. Asked from the routing decision, so the two cannot disagree: a
 * selector of `none,console` is still served and draws no warning.
 */
export function warnOnConsolePairing(env: NodeJS.ProcessEnv): void {
  for (const signal of SIGNALS) {
    const names = readSelectors(env, signal);
    if (
      names.includes('console') &&
      resolveDestination(env, signal) !== 'stream'
    ) {
      diag.warn(
        `${SELECTORS[signal]} lists console alongside another exporter; ` +
          'console is dropped, because serving it from stderr would replace ' +
          'the others entirely.'
      );
    }
  }
}
