import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {EnvironmentError} from '../errors/index.mts';
import {
  hasLinearToken,
  requireLinearToken,
  resolveCredentials,
} from './token.mts';

describe('resolveCredentials', () => {
  it('puts a personal api key in the slot that is sent bare', () => {
    assert.deepEqual(resolveCredentials('lin_api_abc'), {
      apiKey: 'lin_api_abc',
    });
  });

  it('strips a Bearer prefix an operator added to an api key', () => {
    assert.deepEqual(resolveCredentials('Bearer lin_api_abc'), {
      apiKey: 'lin_api_abc',
    });
  });

  it('puts a token that is not an api key in the slot that gets Bearer', () => {
    assert.deepEqual(resolveCredentials('oauth-token'), {
      accessToken: 'oauth-token',
    });
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
      assert.deepEqual(resolveCredentials(written), {
        accessToken: 'oauth-token',
      });
    }
  });

  it('trims surrounding whitespace', () => {
    assert.deepEqual(resolveCredentials('  lin_api_abc\n'), {
      apiKey: 'lin_api_abc',
    });
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
