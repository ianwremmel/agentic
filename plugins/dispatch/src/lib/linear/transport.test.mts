import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError, EnvironmentError} from '../errors/index.mts';
import {
  authorization,
  createTransport,
  hasLinearToken,
  requireLinearToken,
} from './transport.mts';
import type {Fetcher} from './transport.mts';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json'},
    ...init,
  });
}

function stub(response: Response | (() => Response | Promise<Response>)): {
  fetch: Fetcher;
  calls: {url: string; init: RequestInit}[];
} {
  const calls: {url: string; init: RequestInit}[] = [];
  const fetcher = (async (url: unknown, init: unknown) => {
    calls.push({url: String(url), init: init as RequestInit});
    return typeof response === 'function' ? response() : response;
  }) as Fetcher;
  return {fetch: fetcher, calls};
}

describe('authorization', () => {
  it('sends a personal api key as the bare header value', () => {
    assert.equal(authorization('lin_api_abc'), 'lin_api_abc');
  });

  it('bearers anything else', () => {
    assert.equal(authorization('oauth-token'), 'Bearer oauth-token');
  });

  it('leaves a scheme the caller already wrote alone', () => {
    assert.equal(authorization('Bearer mine'), 'Bearer mine');
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
    assert.deepEqual(
      (call.init.headers as Record<string, string>).authorization,
      'lin_api_k'
    );
    assert.deepEqual(JSON.parse(call.init.body as string), {
      query: 'query Q { ok }',
      variables: {a: 1},
    });
  });

  it('maps an invalid-input graphql error onto DataError', async () => {
    const {fetch} = stub(
      json({
        errors: [
          {message: 'Entity not found', extensions: {type: 'entity not found'}},
        ],
      })
    );
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof DataError && error.message.includes('Entity not found')
    );
  });

  it('maps an authentication graphql error onto EnvironmentError', async () => {
    const {fetch} = stub(
      json({
        errors: [
          {message: 'no key', extensions: {type: 'authentication error'}},
        ],
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

  it('maps an unclassified graphql error onto EnvironmentError', async () => {
    const {fetch} = stub(json({errors: [{message: 'boom'}]}));
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) => error instanceof EnvironmentError
    );
  });

  it('reports a 401 as a key problem', async () => {
    const {fetch} = stub(new Response('', {status: 401}));
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError && error.message.includes('api key')
    );
  });

  it('names the retry window when rate-limited', async () => {
    const {fetch} = stub(
      new Response('', {status: 429, headers: {'retry-after': '42'}})
    );
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.hint?.includes('42s') === true
    );
  });

  it('treats a rejected query as a bug in the client, not the data', async () => {
    const {fetch} = stub(new Response('', {status: 400}));
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) => error instanceof DataError
    );
  });

  it('reports an unreachable endpoint rather than throwing the raw fetch error', async () => {
    const fetcher = (() =>
      Promise.reject(new TypeError('fetch failed'))) as Fetcher;
    const execute = createTransport({token: 'k', fetch: fetcher});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('could not reach linear')
    );
  });

  it('aborts a request that outlives the timeout', async () => {
    const fetcher = (async (_url: unknown, init: unknown) => {
      const {signal} = init as {signal: AbortSignal};
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, {once: true});
      });
      throw new Error('aborted');
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

  it('reports a non-JSON body as an environment problem', async () => {
    const {fetch} = stub(new Response('<html>nope</html>', {status: 200}));
    const execute = createTransport({token: 'k', fetch});

    await assert.rejects(
      execute({query: 'q'}),
      (error: unknown) =>
        error instanceof EnvironmentError && error.message.includes('not JSON')
    );
  });
});

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
