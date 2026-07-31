import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {checksXml, type RollupEntry} from './checks.mts';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const OPTS = {informationalRe: '', stuckAfterSec: 3600, nowMs: NOW};

function state(xml: string): string {
  return /<checks state="([^"]+)">/u.exec(xml)?.[1] ?? '';
}

describe('checksXml rollup', () => {
  it('is passing when every check has a non-failing conclusion', () => {
    const rollup: RollupEntry[] = [
      {name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS'},
      {name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL'},
    ];
    assert.equal(state(checksXml(rollup, OPTS)), 'passing');
  });

  it('is pending when any check is still in progress', () => {
    const rollup: RollupEntry[] = [
      {name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS'},
      {name: 'e2e', status: 'IN_PROGRESS', conclusion: ''},
    ];
    assert.equal(state(checksXml(rollup, OPTS)), 'pending');
  });

  it('is failing when a check failed and nothing is pending', () => {
    const rollup: RollupEntry[] = [
      {name: 'build', status: 'COMPLETED', conclusion: 'FAILURE'},
    ];
    assert.equal(state(checksXml(rollup, OPTS)), 'failing');
  });

  it('does not let an informational failure fail the rollup', () => {
    const rollup: RollupEntry[] = [
      {name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS'},
      {name: 'coverage', status: 'COMPLETED', conclusion: 'FAILURE'},
    ];
    const xml = checksXml(rollup, {...OPTS, informationalRe: '^coverage$'});
    assert.equal(state(xml), 'passing');
    assert.match(xml, /name="coverage"[^/]*informational="true"/u);
  });

  it('stops treating a stuck in-progress check as pending, surfacing a real failure', () => {
    const rollup: RollupEntry[] = [
      {
        name: 'hang',
        status: 'IN_PROGRESS',
        conclusion: '',
        startedAt: '2025-12-01T00:00:00Z',
      },
      {name: 'build', status: 'COMPLETED', conclusion: 'FAILURE'},
    ];
    const xml = checksXml(rollup, OPTS);
    assert.equal(
      state(xml),
      'failing',
      'a stuck check no longer masks the failure'
    );
    assert.match(xml, /name="hang"[^/]*stuck="true"/u);
  });

  it('escapes a details URL that carries query separators', () => {
    const rollup: RollupEntry[] = [
      {
        name: 'build',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://ci.example/run?a=1&b=2',
      },
    ];
    const xml = checksXml(rollup, OPTS);
    assert.match(xml, /url="https:\/\/ci\.example\/run\?a=1&amp;b=2"/u);
    assert.doesNotMatch(
      xml,
      /&b=2/u,
      'a bare ampersand would be malformed XML'
    );
  });
});
