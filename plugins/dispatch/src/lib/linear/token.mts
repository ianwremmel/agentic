import {EnvironmentError, ensure} from '../errors/index.mts';

export const LINEAR_TOKEN_VAR = 'LINEAR_API_KEY';

const BEARER = /^Bearer\s+/iu;

/**
 * Which credential slot the token goes in. The SDK sends an `apiKey` bare and
 * prefixes an `accessToken` with `Bearer`, which is the distinction Linear's
 * API draws — a personal key with a `Bearer` prefix is answered with HTTP 400.
 * `LINEAR_API_KEY` can hold either kind, so the `lin_api_` prefix Linear puts
 * on a personal key decides. Either way the token is handed over bare: the
 * SDK's own prefix check is case-sensitive against `Bearer `, so passing one
 * written `bearer x` straight through would be sent `Bearer bearer x`.
 */
export function resolveCredentials(
  token: string
): {apiKey: string} | {accessToken: string} {
  const bare = token.trim().replace(BEARER, '');
  return bare.startsWith('lin_api_') ? {apiKey: bare} : {accessToken: bare};
}

/** Whether the environment can drive Linear directly, without deciding anything else. */
export function hasLinearToken(env: NodeJS.ProcessEnv): boolean {
  const token = env[LINEAR_TOKEN_VAR];
  return typeof token === 'string' && token.trim() !== '';
}

/** The key, or an `EnvironmentError` naming the variable that is missing. */
export function requireLinearToken(env: NodeJS.ProcessEnv): string {
  const token = env[LINEAR_TOKEN_VAR]?.trim() ?? '';
  ensure(
    token !== '',
    () =>
      new EnvironmentError(`${LINEAR_TOKEN_VAR} is not set`, {
        hint: `export ${LINEAR_TOKEN_VAR}=<linear api key> to let dispatch read Linear itself, or leave it unset to fetch through an agent session.`,
      })
  );
  return token;
}
