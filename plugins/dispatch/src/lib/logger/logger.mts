export type LogMethod = (
  message: string,
  meta?: Record<string, unknown>
) => void;

export const LEVELS = [
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'log',
] as const;

export type CoreLogger = Record<(typeof LEVELS)[number], LogMethod>;

export interface Logger extends CoreLogger {
  child(meta: Record<string, unknown>): Logger;
}

/**
 * Wrap a console-shaped sink so every call carries accumulated metadata and the
 * logger gains a `child()` binder. The default sink is `console`; the MCP server
 * passes a stderr-bound sink so it never writes to the JSON-RPC channel.
 *
 * Bound metadata wins over a colliding key at the call site, and a deeper
 * `child()` wins over a shallower one. When the merged metadata is empty the
 * sink is called without a metadata argument, so plain calls stay plain.
 */
export function createLogger(sink: CoreLogger = console): Logger {
  const bind = (bound: Record<string, unknown>): Logger =>
    new Proxy(sink, {
      get(target, prop, receiver) {
        if (prop === 'child') {
          return (meta: Record<string, unknown>): Logger =>
            bind({...bound, ...meta});
        }
        if (
          typeof prop === 'string' &&
          (LEVELS as readonly string[]).includes(prop)
        ) {
          const method = Reflect.get(target, prop, receiver) as LogMethod;
          return (message: string, meta?: Record<string, unknown>): void => {
            const merged = {...meta, ...bound};
            if (Object.keys(merged).length === 0) {
              method.call(target, message);
            } else {
              method.call(target, message, merged);
            }
          };
        }
        const passthrough: unknown = Reflect.get(target, prop, receiver);
        return passthrough;
      },
    }) as Logger;

  return bind({});
}
