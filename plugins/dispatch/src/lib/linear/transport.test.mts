import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {describe, it} from 'node:test';

import {
  DataError,
  DefinitionError,
  EnvironmentError,
} from '../errors/index.mts';
import {
  createTransport,
  credentials,
  hasLinearToken,
  requireLinearToken,
} from './transport.mts';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

type Answer = (init: RequestInit) => Promise<Response> | Response;

/**
 * The SDK reads `globalThis.fetch` at call time, so that is the seam a test
 * without a socket takes. `t.mock` restores the real one when the test ends.
 */
function stub(t: TestContext, answer: Answer): Call[] {
  const calls: Call[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: unknown, init: unknown): Promise<Response> => {
      calls.push({url: String(url), init: init as RequestInit});
      return answer(init as RequestInit);
    }
  );
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
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

describe('credentials', () => {
  it('puts a personal api key in the slot that is sent bare', () => {
    assert.deepEqual(credentials('lin_api_abc'), {apiKey: 'lin_api_abc'});
  });

  it('strips a Bearer prefix an operator added to an api key', () => {
    assert.deepEqual(credentials('Bearer lin_api_abc'), {
      apiKey: 'lin_api_abc',
    });
  });

  it('puts a token that is not an api key in the slot that gets Bearer', () => {
    assert.deepEqual(credentials('oauth-token'), {accessToken: 'oauth-token'});
  });

  // The SDK adds `Bearer ` only when the token does not already start with
  // exactly that, so handing back anything else spelled it doubles the prefix.
  it('hands back an access token bare however its prefix was written', () => {
    for (const written of [
      'Bearer oauth-token',
      'bearer oauth-token',
      'BEARER  oauth-token',
      'Bearer\toauth-token',
    ]) {
      assert.deepEqual(credentials(written), {accessToken: 'oauth-token'});
    }
  });

  it('trims surrounding whitespace', () => {
    assert.deepEqual(credentials('  lin_api_abc\n'), {apiKey: 'lin_api_abc'});
  });
});

describe('createTransport', () => {
  it('posts the query and variables and returns data', async (t) => {
    const calls = stub(t, () => json({data: {ok: true}}));
    const execute = createTransport({token: 'lin_api_k'});

    const data = await execute<{ok: boolean}>({
      query: 'query Q { ok }',
      variables: {a: 1},
    });

    assert.deepEqual(data, {ok: true});
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'https://api.linear.app/graphql');
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(JSON.parse(call.init.body as string), {
      query: 'query Q { ok }',
      variables: {a: 1},
    });
  });

  it('sends a personal api key as the bare Authorization value', async (t) => {
    const calls = stub(t, () => json({data: {ok: true}}));

    await createTransport({token: 'lin_api_k'})({query: 'q'});

    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'lin_api_k');
  });

  it('sends anything else as a Bearer token, prefixed exactly once', async (t) => {
    const calls = stub(t, () => json({data: {ok: true}}));

    await createTransport({token: 'bearer oauth-token'})({query: 'q'});

    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer oauth-token');
  });

  it('refuses a blank token on the taxonomy rather than off it', () => {
    for (const token of ['', '   ']) {
      assert.throws(
        () => createTransport({token}),
        (error: unknown) =>
          error instanceof EnvironmentError &&
          error.hint?.includes('LINEAR_API_KEY') === true
      );
    }
  });

  it('refuses an endpoint the SDK will not take, with a hint naming it', () => {
    assert.throws(
      () => createTransport({token: 'k', endpoint: 'http://example.com/gql'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.hint?.includes('https') === true
    );
  });

  it('keeps the diagnostic when Linear rejects the query with HTTP 400', async (t) => {
    stub(t, () => json(VALIDATION_ERROR, 400));
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof DefinitionError &&
        error.message.includes('Cannot query field "nope"')
    );
  });

  it('reads the errors of a 401 rather than reporting the status alone', async (t) => {
    stub(t, () => json(AUTH_ERROR, 401));
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('not authenticated') &&
        error.hint?.includes('LINEAR_API_KEY') === true
    );
  });

  it('maps an entity Linear cannot find onto DataError', async (t) => {
    stub(t, () => json(INPUT_ERROR));
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof DataError &&
        error.message.includes('Entity not found: Project')
    );
  });

  it('names a rate limit as something to wait out', async (t) => {
    stub(t, () =>
      json(
        {
          errors: [
            {message: 'Rate limit exceeded', extensions: {type: 'ratelimited'}},
          ],
        },
        400
      )
    );
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('rate-limited') &&
        error.hint?.includes('wait') === true
    );
  });

  it('classifies on the most explanatory error, not the first one listed', async (t) => {
    stub(t, () =>
      json({errors: [...INPUT_ERROR.errors, ...AUTH_ERROR.errors]})
    );
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.hint?.includes('LINEAR_API_KEY') === true &&
        // The SDK's own message is the first error's alone, which would name
        // the entity while the class names the key.
        error.message.includes('not authenticated') &&
        error.message.includes('Entity not found')
    );
  });

  it('does not park the refresh on a graphql error that is not a validation failure', async (t) => {
    // `graphql error` is the label Linear puts on anything raised in the
    // GraphQL layer. Only the validation code is terminal.
    stub(t, () =>
      json(
        {
          errors: [
            {message: 'something broke', extensions: {type: 'graphql error'}},
          ],
        },
        400
      )
    );
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.hint?.includes('linearstatus.com') === true
    );
  });

  it('classifies by the error code even where the prose type disagrees', async (t) => {
    // The SDK reads only `extensions.type`, so nothing but this keeps the code
    // authoritative: reported by its prose type, a missing entity would read as
    // a query this plugin has to fix.
    stub(t, () =>
      json({
        errors: [
          {
            message: 'Entity not found: Project',
            extensions: {type: 'graphql error', code: 'INPUT_ERROR'},
          },
        ],
      })
    );
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof DataError &&
        error.hint?.includes('does not exist on Linear') === true
    );
  });

  it('still classifies an error carrying only the prose type', async (t) => {
    stub(t, () =>
      json({errors: [{message: 'nope', extensions: {type: 'ratelimited'}}]})
    );
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('rate-limited')
    );
  });

  it('falls back to the status when the body carries no errors to read', async (t) => {
    stub(t, () => new Response('gateway down', {status: 502}));
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('502') &&
        error.message.includes('gateway down') &&
        error.hint?.includes('linearstatus.com') === true
    );
  });

  // The SDK reads any bare 4xx as an authentication failure. Passed on as one,
  // a bad request would send the reader off to rotate a key that works.
  it('does not blame the api key for a bare 400', async (t) => {
    stub(t, () => new Response('bad request', {status: 400}));
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.hint?.includes('LINEAR_API_KEY') !== true
    );
  });

  it('names a bare 401 as the api key', async (t) => {
    stub(t, () => new Response('nope', {status: 401}));
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.hint?.includes('LINEAR_API_KEY') === true
    );
  });

  it('refuses a 200 that carries neither data nor errors', async (t) => {
    stub(t, () => json({}));
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('neither data nor errors') &&
        error.hint?.includes('retry') === true
    );
  });

  it('reports an unreachable endpoint, keeping the original as the cause', async (t) => {
    const failure = new TypeError('fetch failed');
    stub(t, () => Promise.reject(failure));
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('could not read an answer from linear') &&
        error.cause === failure
    );
  });

  it('aborts a request that outlives the timeout', async (t) => {
    stub(t, hangUntilAborted());
    const execute = createTransport({token: 'k', timeoutMs: 5});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('did not answer within 5ms')
    );
  });

  it('lets a cancellation the caller asked for propagate as itself', async (t) => {
    const controller = new AbortController();
    stub(
      t,
      hangUntilAborted(() => {
        controller.abort(new Error('caller cancelled'));
      })
    );
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q', signal: controller.signal}),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'caller cancelled' &&
        !(error instanceof EnvironmentError)
    );
  });

  it('does not blame a proxy when the timeout lands mid-body', async (t) => {
    stub(t, ({signal}) => {
      assert.ok(signal);
      return {
        ok: true,
        status: 200,
        headers: new Headers({'content-type': 'application/json'}),
        json: async () => {
          await new Promise((resolve) => {
            signal.addEventListener('abort', resolve, {once: true});
          });
          throw signal.reason as Error;
        },
      } as unknown as Response;
    });
    const execute = createTransport({token: 'k', timeoutMs: 5});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('did not answer within 5ms')
    );
  });

  it('blames a proxy for a 200 that is not a GraphQL answer at all', async (t) => {
    stub(t, () => new Response('<html>nope</html>', {status: 200}));
    const execute = createTransport({token: 'k'});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('<html>nope</html>') &&
        error.hint?.includes('proxy') === true
    );
  });

  // Both shapes make the SDK's own error parsing throw rather than classify.
  // Reported as a bad answer, they still reach the caller with a remedy; left
  // to escape, they would crash past the taxonomy.
  it('reports a body that is JSON but not a GraphQL envelope', async (t) => {
    let body: unknown;
    stub(t, () => json(body));
    const execute = createTransport({token: 'k'});

    for (const shape of [{errors: 'oops'}, null]) {
      body = shape;
      await assert.rejects(
        execute({query: 'q'}),
        (error: unknown) =>
          error instanceof EnvironmentError &&
          // The hint is the point: it is the only thing that tells the reader
          // to suspect whatever is answering for Linear.
          error.hint?.includes('answering in its place') === true &&
          // A garbled body and a dead connection share a message, so the cause
          // is what separates them: this one came out of the SDK's parsing.
          error.cause instanceof TypeError
      );
    }
  });
});

// Each of these rows is a Linear error type the module claims to translate.
// Without the table they are unreachable by any other test here.
describe('linear error types', () => {
  const cases: [string, string, (error: unknown) => boolean][] = [
    [
      'usage limit exceeded',
      'usage limit exceeded',
      (error) =>
        error instanceof EnvironmentError &&
        error.message.includes('rate-limited'),
    ],
    [
      'forbidden',
      'forbidden',
      (error) =>
        error instanceof EnvironmentError &&
        error.hint?.includes('LINEAR_API_KEY') === true,
    ],
    [
      'feature not accessible',
      'feature not accessible',
      (error) =>
        error instanceof EnvironmentError &&
        error.hint?.includes('LINEAR_API_KEY') === true,
    ],
    ['user error', 'user error', (error) => error instanceof DataError],
    [
      'internal error',
      'internal error',
      (error) =>
        error instanceof EnvironmentError &&
        error.hint?.includes('linearstatus.com') === true,
    ],
  ];

  for (const [name, type, holds] of cases) {
    it(`translates ${name}`, async (t) => {
      stub(t, () => json({errors: [{message: name, extensions: {type}}]}, 400));

      await assert.rejects(createTransport({token: 'k'})({query: 'q'}), holds);
    });
  }
});

/**
 * A fetch that never answers, so only the abort decides what the caller sees.
 * It rejects with the signal's reason, which is what `fetch` itself does: a
 * `TimeoutError` for `AbortSignal.timeout`, the caller's own error for an
 * `AbortController` given one.
 */
function hangUntilAborted(onCall?: () => void): Answer {
  return ({signal}) => {
    assert.ok(signal);
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
