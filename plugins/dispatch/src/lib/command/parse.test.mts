import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parseOptions} from './parse.mts';
import type {OptionsRecord} from './abstract-command.mts';
import {UsageError} from '../errors/index.mts';

const options: OptionsRecord = {
  loud: {type: 'boolean', description: 'd', positional: false, required: false},
  count: {
    type: 'number',
    description: 'd',
    positional: false,
    required: false,
    default: 3,
  },
  name: {type: 'string', description: 'd', positional: false, required: true},
  format: {
    type: 'string',
    description: 'd',
    positional: false,
    required: false,
    choices: ['json', 'text'],
  },
};

describe('parseOptions', () => {
  it('defaults a missing boolean to false and applies numeric defaults', () => {
    const parsed = parseOptions(options, {name: 'ada'});
    assert.equal(parsed.loud, false);
    assert.equal(parsed.count, 3);
    assert.equal(parsed.name, 'ada');
  });

  it('coerces a numeric string to a number', () => {
    const parsed = parseOptions(options, {name: 'ada', count: '10'});
    assert.equal(parsed.count, 10);
  });

  it('rejects a non-numeric value for a number option', () => {
    assert.throws(
      () => parseOptions(options, {name: 'ada', count: 'abc'}),
      UsageError
    );
    assert.throws(
      () => parseOptions(options, {name: 'ada', count: ''}),
      UsageError
    );
  });

  it('rejects a missing required option', () => {
    assert.throws(() => parseOptions(options, {}), UsageError);
  });

  it('rejects a value outside choices and accepts one inside', () => {
    assert.throws(
      () => parseOptions(options, {name: 'ada', format: 'xml'}),
      UsageError
    );
    const parsed = parseOptions(options, {name: 'ada', format: 'json'});
    assert.equal(parsed.format, 'json');
  });

  it('omits an absent optional non-boolean option', () => {
    const parsed = parseOptions(options, {name: 'ada'});
    assert.equal('format' in parsed, false);
  });

  it('coerces a string default for a number option to a number', () => {
    const withStringDefault: OptionsRecord = {
      count: {
        type: 'number',
        description: 'd',
        positional: false,
        required: false,
        default: '3',
      },
    };
    const parsed = parseOptions(withStringDefault, {});
    assert.equal(parsed.count, 3);
    assert.equal(typeof parsed.count, 'number');
  });

  it('accepts a default that satisfies choices', () => {
    const withValidDefault: OptionsRecord = {
      format: {
        type: 'string',
        description: 'd',
        positional: false,
        required: false,
        choices: ['json', 'text'],
        default: 'text',
      },
    };
    const parsed = parseOptions(withValidDefault, {});
    assert.equal(parsed.format, 'text');
  });

  it('rejects a default that violates choices', () => {
    const withInvalidDefault: OptionsRecord = {
      format: {
        type: 'string',
        description: 'd',
        positional: false,
        required: false,
        choices: ['json', 'text'],
        default: 'xml',
      },
    };
    assert.throws(() => parseOptions(withInvalidDefault, {}), UsageError);
  });
});
