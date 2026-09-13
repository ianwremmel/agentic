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

/** The four properties the SDK derives `exception.*` from. */
type ExceptionKey = 'code' | 'message' | 'name' | 'stack';
const EXCEPTION_KEYS: readonly ExceptionKey[] = [
  'code',
  'message',
  'name',
  'stack',
];

/** What a record says when the thrown value yielded nothing legible. */
const UNREADABLE = 'a thrown value that could not be read';

/**
 * Stringify the four properties the SDK reads, each under its own guard, so one
 * hostile getter costs its own field rather than the other three.
 *
 * `threw` separates a property that was absent from one whose read failed: a
 * value none of whose properties could be read still has to produce a record
 * saying so, and `String()` on it will not be the thing to say it.
 */
function snapshot(thrown: object): {
  fields: Partial<Record<ExceptionKey, string>>;
  threw: boolean;
} {
  const fields: Partial<Record<ExceptionKey, string>> = {};
  let threw = false;
  for (const key of EXCEPTION_KEYS) {
    try {
      const value: unknown = (thrown as Partial<Record<ExceptionKey, unknown>>)[
        key
      ];
      /* eslint-disable-next-line @typescript-eslint/no-base-to-string --
         whatever the value's own `toString` produces is the best description of
         it available, and even `[object Object]` beats dropping the only thing
         the record was reporting. */
      if (value) fields[key] = String(value);
    } catch {
      threw = true;
    }
  }
  return {fields, threw};
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
 * failure being reported with a failure to report it. So every read happens here
 * under a guard, and what goes back is a plain object of strings — the SDK reads
 * those same four properties again, and on this one no read of them runs code.
 */
function recordable(thrown: unknown): unknown {
  try {
    if (typeof thrown === 'string' || typeof thrown === 'number') return thrown;
    if (typeof thrown === 'object' && thrown !== null) {
      const {fields, threw} = snapshot(thrown);
      if (Object.keys(fields).length > 0) return fields;
      if (threw) return UNREADABLE;
    }
    return String(thrown);
  } catch {
    return UNREADABLE;
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
