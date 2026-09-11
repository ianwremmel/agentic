import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  DataError,
  DefinitionError,
  EnvironmentError,
} from '../errors/index.mts';
import {
  authorization,
  createTransport,
  hasLinearToken,
  requireLinearToken,
} from './transport.mts';
import type {Fetcher} from './transport.mts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

function stub(response: Response): {
  fetch: Fetcher;
  calls: {url: string; init: RequestInit}[];
} {
  const calls: {url: string; init: RequestInit}[] = [];
  const fetcher = ((url: unknown, init: unknown) => {
    calls.push({url: String(url), init: init as RequestInit});
    return Promise.resolve(response);
  }) as Fetcher;
  return {fetch: fetcher, calls};
}

/** Linear's real payload for a query naming a field the schema does not have. */
const VALIDATION_ERROR = {
  errors: [
    {
      message: 'Cannot query field "nope" on type "Issue".',
      extensions: {type: 'graphql error', code: 'GRAPHQL_VALIDATION_FAILED'},
    },
  ],
};

/** Linear's real payload for an entity the key cannot see or that does not exist. */
const INPUT_ERROR = {
  errors: [
    {
      message: 'Entity not found: Project',
      extensions: {type: 'invalid input', code: 'INPUT_ERROR'},
    },
  ],
};

/** Linear's real payload for a rejected key, which arrives with HTTP 401. */
const AUTH_ERROR = {
  errors: [
    {
      message: 'Authentication required, not authenticated',
      extensions: {type: 'authentication error', code: 'AUTHENTICATION_ERROR'},
    },
  ],
};

describe('authorization', () => {
  it('sends a personal api key as the bare header value', () => {
    assert.equal(authorization('lin_api_abc'), 'lin_api_abc');
  });

  it('strips a Bearer prefix an operator added to an api key', () => {
    assert.equal(authorization('Bearer lin_api_abc'), 'lin_api_abc');
  });

  it('leaves a token that is not an api key exactly as written', () => {
    assert.equal(authorization('Bearer oauth-token'), 'Bearer oauth-token');
    assert.equal(authorization('oauth-token'), 'oauth-token');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(authorization('  lin_api_abc\n'), 'lin_api_abc');
  });
});

describe('createTransport', () => {
  it('posts the query and variables and returns data', async () => {
    const {fetch, calls} = stub(json({data: {ok: true}}));
    const execute = createTransport({token: 'lin_api_k', fetch});

    const data = await execute<{ok: boolean}>({
      query: 'query Q { ok }',
      variables: {a: 1},
    });

    assert.deepEqual(data, {ok: true});
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'https://api.linear.app/graphql');
    assert.equal(call.init.method, 'POST');
    assert.equal(
      (call.init.headers as Record<string, string>).authorization,
      'lin_api_k'
    );
    assert.deepEqual(JSON.parse(call.init.body as string), {
      query: 'query Q { ok }',
      variables: {a: 1},
    });
  });

  it('keeps the diagnostic when Linear rejects the query with HTTP 400', async () => {
    const {fetch} = stub(json(VALIDATION_ERROR, 400));
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof DefinitionError &&
        error.message.includes('Cannot query field "nope"')
    );
  });

  it('reads the errors of a 401 rather than reporting the status alone', async () => {
    const {fetch} = stub(json(AUTH_ERROR, 401));
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('not authenticated') &&
        error.hint?.includes('LINEAR_API_KEY') === true
    );
  });

  it('maps an entity Linear cannot find onto DataError', async () => {
    const {fetch} = stub(json(INPUT_ERROR));
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof DataError &&
        error.message.includes('Entity not found: Project')
    );
  });

  it('names a rate limit as something to wait out', async () => {
    const {fetch} = stub(
      json(
        {
          errors: [
            {
              message: 'Rate limit exceeded',
              extensions: {type: 'ratelimited', code: 'RATELIMITED'},
            },
          ],
        },
        400
      )
    );
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('rate-limited') &&
        error.hint?.includes('wait') === true
    );
  });

  it('classifies on the most explanatory error, not the first one listed', async () => {
    const {fetch} = stub(
      json({
        errors: [...INPUT_ERROR.errors, ...AUTH_ERROR.errors],
      })
    );
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.hint?.includes('LINEAR_API_KEY') === true
    );
  });

  it('falls back to the status when the body carries no errors to read', async () => {
    const {fetch} = stub(new Response('gateway down', {status: 502}));
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError && error.message.includes('HTTP 502')
    );
  });

  it('reports an unreachable endpoint, keeping the original as the cause', async () => {
    const failure = new TypeError('fetch failed');
    const fetcher = (() => Promise.reject(failure)) as Fetcher;
    const execute = createTransport({token: 'k', fetch: fetcher});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('could not reach linear') &&
        error.cause === failure
    );
  });

  it('aborts a request that outlives the timeout', async () => {
    const execute = createTransport({
      token: 'k',
      fetch: hangUntilAborted(),
      timeoutMs: 5,
    });

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('did not answer within 5ms')
    );
  });

  it('lets a cancellation the caller asked for propagate as itself', async () => {
    const controller = new AbortController();
    const execute = createTransport({
      token: 'k',
      fetch: hangUntilAborted(() => {
        controller.abort(new Error('caller cancelled'));
      }),
    });

    await assert.rejects(
      execute({query: 'q', signal: controller.signal}),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'caller cancelled' &&
        !(error instanceof EnvironmentError)
    );
  });

  it('does not blame a proxy when the timeout lands mid-body', async () => {
    const fetcher = ((_url: unknown, init: unknown) => {
      const {signal} = init as {signal: AbortSignal};
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => {
          await new Promise((resolve) => {
            signal.addEventListener('abort', resolve, {once: true});
          });
          throw signal.reason as Error;
        },
      } as unknown as Response);
    }) as Fetcher;
    const execute = createTransport({token: 'k', fetch: fetcher, timeoutMs: 5});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('did not answer within 5ms')
    );
  });

  it('refuses a body that is neither data nor errors', async () => {
    const {fetch} = stub(json({}));
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('neither data nor errors')
    );
  });

  it('reports a 200 that is not JSON as an environment problem', async () => {
    const {fetch} = stub(new Response('<html>nope</html>', {status: 200}));
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError && error.message.includes('not JSON')
    );
  });
});

/**
 * A fetch that never answers, so only the abort decides what the caller sees.
 * It rejects with the signal's reason, which is what `fetch` itself does: a
 * `TimeoutError` for `AbortSignal.timeout`, the caller's own error for an
 * `AbortController` given one.
 */
function hangUntilAborted(onCall?: () => void): Fetcher {
  return (_url: unknown, init: unknown) => {
    const {signal} = init as {signal: AbortSignal};
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(signal.reason as Error);
        },
        {once: true}
      );
      // After the listener is attached, or an abort raised here is never heard.
      onCall?.();
    });
  };
}

describe('linear token', () => {
  it('reads a token that is present and non-blank', () => {
    assert.equal(hasLinearToken({LINEAR_API_KEY: 'k'}), true);
    assert.equal(hasLinearToken({LINEAR_API_KEY: '  '}), false);
    assert.equal(hasLinearToken({}), false);
  });

  it('trims the token it hands back', () => {
    assert.equal(requireLinearToken({LINEAR_API_KEY: ' k \n'}), 'k');
  });

  it('names the variable when it is missing', () => {
    assert.throws(
      () => requireLinearToken({}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('LINEAR_API_KEY')
    );
  });
});
