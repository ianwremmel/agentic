import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  informationalPattern,
  resolveCacheDir,
  resolveOperatorLogin,
  stuckAfterSeconds,
} from './config.mts';

function reader(files: Record<string, string>) {
  return (path: string) => Promise.resolve(files[path]);
}

const ROOT = '/repo';
const LOCAL = '/repo/.claude/settings.local.json';
const PROJECT = '/repo/.claude/settings.json';

function withPlugin(key: string, login: string): string {
  return JSON.stringify({
    pluginConfigs: {[key]: {options: {operator_login: login}}},
  });
}

describe('resolveOperatorLogin', () => {
  it('prefers the injected env var over any settings file', async () => {
    const {login} = await resolveOperatorLogin({
      env: {CLAUDE_PLUGIN_OPTION_OPERATOR_LOGIN: 'from-env'},
      readFile: reader({[PROJECT]: withPlugin('land', 'from-file')}),
      projectRoot: ROOT,
    });
    assert.equal(login, 'from-env');
  });

  it('reads the land plugin key from settings, local winning over project', async () => {
    const {login} = await resolveOperatorLogin({
      env: {},
      readFile: reader({
        [LOCAL]: withPlugin('land', 'local-login'),
        [PROJECT]: withPlugin('land', 'project-login'),
      }),
      projectRoot: ROOT,
    });
    assert.equal(login, 'local-login');
  });

  it('matches a marketplace-qualified key (land@agentic)', async () => {
    const {login} = await resolveOperatorLogin({
      env: {},
      readFile: reader({[PROJECT]: withPlugin('land@agentic', 'marketed')}),
      projectRoot: ROOT,
    });
    assert.equal(login, 'marketed');
  });

  it('warns and skips an unparseable higher-precedence file, then falls through', async () => {
    const {login, warnings} = await resolveOperatorLogin({
      env: {},
      readFile: reader({
        [LOCAL]: '{ not json',
        [PROJECT]: withPlugin('land', 'project-login'),
      }),
      projectRoot: ROOT,
    });
    assert.equal(login, 'project-login');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /could not parse/u);
  });

  it('returns undefined when nothing carries a login', async () => {
    const {login} = await resolveOperatorLogin({
      env: {},
      readFile: reader({}),
      projectRoot: ROOT,
    });
    assert.equal(login, undefined);
  });

  it('ignores a different plugin key', async () => {
    const {login} = await resolveOperatorLogin({
      env: {},
      readFile: reader({[PROJECT]: withPlugin('dispatch', 'not-ours')}),
      projectRoot: ROOT,
    });
    assert.equal(login, undefined);
  });
});

describe('resolveCacheDir', () => {
  it('honors LAND_CACHE_DIR and slugs owner/repo', () => {
    assert.equal(
      resolveCacheDir({LAND_CACHE_DIR: '/c'}, 'owner/repo', '5'),
      '/c/deliver/owner__repo/5'
    );
  });

  it('falls back to XDG_CACHE_HOME/land', () => {
    assert.equal(
      resolveCacheDir({XDG_CACHE_HOME: '/x'}, 'o/r', '9'),
      '/x/land/deliver/o__r/9'
    );
  });
});

describe('tuning knobs', () => {
  it('reads the informational pattern, defaulting to empty', () => {
    assert.equal(informationalPattern({}), '');
    assert.equal(
      informationalPattern({LAND_INFORMATIONAL_CHECKS: '^cov$'}),
      '^cov$'
    );
  });

  it('reads the stuck threshold, defaulting to an hour', () => {
    assert.equal(stuckAfterSeconds({}), 3600);
    assert.equal(stuckAfterSeconds({LAND_STUCK_AFTER_SEC: '120'}), 120);
    assert.equal(stuckAfterSeconds({LAND_STUCK_AFTER_SEC: 'nonsense'}), 3600);
  });
});
