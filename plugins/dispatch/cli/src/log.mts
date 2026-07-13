/**
 * logfmt logging on stderr. stdout is reserved for command output (the
 * project-graph document), so a caller can always pipe stdout without
 * scrubbing log lines out of it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogValue = string | number | boolean | null | undefined;

let minLevel: LogLevel = 'info';

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * logfmt quoting: a value is quoted when it is empty or carries a space, a
 * quote, or an `=` — anything that would otherwise break key=value scanning.
 */
export function formatValue(value: LogValue): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  if (raw === '' || /[\s"=]/.test(raw)) {
    return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return raw;
}

export function formatLine(
  level: LogLevel,
  fields: Record<string, LogValue>,
): string {
  const parts = [`level=${level}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(' ');
}

export function log(level: LogLevel, fields: Record<string, LogValue>): void {
  if (SEVERITY[level] < SEVERITY[minLevel]) return;
  process.stderr.write(`${formatLine(level, fields)}\n`);
}

export const logger = {
  debug: (fields: Record<string, LogValue>) => {
    log('debug', fields);
  },
  info: (fields: Record<string, LogValue>) => {
    log('info', fields);
  },
  warn: (fields: Record<string, LogValue>) => {
    log('warn', fields);
  },
  error: (fields: Record<string, LogValue>) => {
    log('error', fields);
  },
};
