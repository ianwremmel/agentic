import {logs, SeverityNumber} from '@opentelemetry/api-logs';
import type {AnyValueMap, Logger} from '@opentelemetry/api-logs';

/**
 * The instrumentation scope on every record this CLI emits. One scope for the
 * whole plugin, because the scope names the instrumented library rather than
 * the module that emitted the record.
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
   * `exception.*` conventions. For a failure the caller absorbed on purpose.
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

/** Stands in for a thrown value whose properties could not be read. */
const UNREADABLE = 'a thrown value that could not be read';

/**
 * Render one property value as a string. These four are usually strings
 * already; JSON is for the ones that are not, since `String()` flattens an
 * object to `[object Object]`.
 *
 * May throw: `String()` does on a null-prototype object. The caller guards it.
 */
function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return String(value);
  try {
    const json = JSON.stringify(value);
    /* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition --
       the lib types this `string`, but it returns `undefined` for a function,
       a symbol, or a `toJSON` that produces one. `{}` is an object with nothing
       enumerable. Neither says more than `String()` would. */
    if (json !== undefined && json !== '{}') return json;
  } catch {
    // A cycle, a bigint, or a `toJSON` that threw.
  }
  return String(value);
}

/**
 * Read the four properties the SDK derives `exception.*` from, each under its
 * own guard so one throwing getter costs only its own field.
 *
 * `threw` is true when at least one property could not be turned into a string.
 * It matters only when `fields` comes back empty: it distinguishes a value that
 * defeated every read from one that simply had none of these properties.
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
      if (value) fields[key] = render(value);
    } catch {
      // A getter that threw, or a value whose own `toString` did.
      threw = true;
    }
  }
  return {fields, threw};
}

/**
 * Narrow a thrown value to something the SDK will actually record.
 *
 * The SDK derives `exception.*` from a string, a number, or an object with a
 * truthy `code`, `name`, `message`, or `stack`. Everything else — `undefined`,
 * a bare object, a thrown `false`, `{message: ''}` — yields no exception
 * attributes at all, leaving a record that says only that something failed, so
 * those get stringified instead.
 *
 * This never throws, since every caller is inside a `catch` and a failure here
 * would replace the original error with an error about reporting it. Reading a
 * property can run a getter that throws, and `String()` throws on a
 * null-prototype object, so every read happens here under a guard. When the
 * return value is an object, its four properties are plain strings, so the
 * SDK's own re-read of them runs no code either.
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
  // `thrown` is boxed so `emit` can tell "no exception" from an exception whose
  // value happens to be `undefined`.
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
 * Resolved at import, before `startTelemetry` registers anything: the API hands
 * back a proxy that drops records until the SDK is registered and forwards them
 * after. So a module imported before startup can still log, and a command that
 * never starts telemetry emits into a logger that goes nowhere rather than
 * failing.
 */
export const log: Log = createLog(logs.getLogger(SCOPE));
