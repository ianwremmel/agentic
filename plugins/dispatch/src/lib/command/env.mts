import {EnvironmentError, ensure} from '../errors/index.mts';

/** Throw if any variable a command declared in `env` is absent from the environment. */
export function assertEnv(
  required: readonly string[],
  env: NodeJS.ProcessEnv
): void {
  const missing = required.filter((key) => env[key] === undefined);
  ensure(
    missing.length === 0,
    () =>
      new EnvironmentError(
        `missing required environment: ${missing.join(', ')}`,
        {
          hint: `set ${missing.join(', ')} before running this command`,
        }
      )
  );
}
