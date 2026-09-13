import {logs, SeverityNumber} from '@opentelemetry/api-logs';
import type {AnyValueMap, Logger} from '@opentelemetry/api-logs';

/**
 * The instrumentation scope on every record this CLI emits. One scope, not one
 * per module: the scope names the instrumented library, and the whole plugin is
 * one. Which module spoke is a question for the span a record sits under.
 */
const SCOPE = 'dispatch';

/** Attributes on a record. Identity keys — `node`, `repo`, `pr` — go here. */
export type LogFields = Readonly<AnyValueMap>;

export interface Log {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /**
   * `warn`, carrying the thrown value's type, message, and stack under the
   * `exception.*` conventions. For a failure the caller absorbs on purpose —
   * a degraded result it went on to use.
   */
  warnException(message: string, thrown: unknown, fields?: LogFields): void;
  /** `error`, carrying the thrown value the same way. */
  errorException(message: string, thrown: unknown, fields?: LogFields): void;
}

/**
 * Narrow a thrown value to something the SDK will actually record.
 *
 * It derives `exception.*` from a string, a number, or an object with a *truthy*
 * `code`, `name`, `message`, or `stack` — so `undefined`, a bare object, a
 * thrown `false`, and `{message: ''}` alike produce no exception attributes at
 * all, and the record would say only that something failed. Stringify those: a
 * lossy exception beats a silent one.
 *
 * Total by construction, because every caller is inside a `catch` that is
 * recovering from something. `String()` throws on a null-prototype object, and
 * reading a property can run a getter that throws; either would replace the
 * failure being reported with a failure to report it. Destructuring runs all
 * four getters under the guard, so a value that gets past here cannot throw when
 * the SDK reads it.
 */
function recordable(thrown: unknown): unknown {
  try {
    if (typeof thrown === 'string' || typeof thrown === 'number') return thrown;
    if (typeof thrown === 'object' && thrown !== null) {
      const {code, message, name, stack} = thrown as Partial<
        Record<'code' | 'message' | 'name' | 'stack', unknown>
      >;
      if (code || message || name || stack) return thrown;
    }
    return String(thrown);
  } catch {
    return 'a thrown value that could not be read';
  }
}

function createLog(logger: Logger): Log {
  // `thrown` is boxed so that a caller who was handed `undefined` by a `throw`
  // still gets an `exception.message`, rather than the record silently losing
  // the only thing it was reporting.
  const emit = (
    severityNumber: SeverityNumber,
    severityText: string,
    message: string,
    fields: LogFields | undefined,
    thrown?: {value: unknown}
  ): void => {
    logger.emit({
      ...(fields === undefined ? {} : {attributes: fields}),
      ...(thrown === undefined ? {} : {exception: recordable(thrown.value)}),
      body: message,
      severityNumber,
      severityText,
    });
  };

  return {
    debug: (message, fields) => {
      emit(SeverityNumber.DEBUG, 'DEBUG', message, fields);
    },
    error: (message, fields) => {
      emit(SeverityNumber.ERROR, 'ERROR', message, fields);
    },
    errorException: (message, thrown, fields) => {
      emit(SeverityNumber.ERROR, 'ERROR', message, fields, {value: thrown});
    },
    info: (message, fields) => {
      emit(SeverityNumber.INFO, 'INFO', message, fields);
    },
    warn: (message, fields) => {
      emit(SeverityNumber.WARN, 'WARN', message, fields);
    },
    warnException: (message, thrown, fields) => {
      emit(SeverityNumber.WARN, 'WARN', message, fields, {value: thrown});
    },
  };
}

/**
 * The one logger the CLI emits through. Process-wide, so no module has to be
 * handed one to be able to log.
 *
 * Resolved at import, before `startTelemetry` has registered anything: the API
 * hands back a proxy that discards records until the SDK is registered and
 * follows it from then on. A module imported before startup therefore logs, and
 * a command that never starts telemetry costs nothing.
 */
export const log: Log = createLog(logs.getLogger(SCOPE));
