import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {setVersion} from './set-plugin-version.mts';

const manifest = [
  '{',
  '  "name": "dispatch",',
  '  "description": "Does a thing \\u2014 and another.",',
  '  "version": "0.32.0",',
  '  "license": "MIT"',
  '}',
  '',
].join('\n');

describe('setVersion', () => {
  it('replaces the version and leaves the rest byte-identical', () => {
    const result = setVersion(manifest, '1.0.0');

    assert.equal(result, manifest.replace('0.32.0', '1.0.0'));
  });

  it('accepts prerelease and build metadata', () => {
    assert.match(
      setVersion(manifest, '2.0.0-beta.1+build.7'),
      /"version": "2\.0\.0-beta\.1\+build\.7"/
    );
  });

  it('rejects a version that is not semver', () => {
    // A release step that writes `v1.2.3` or `latest` into a manifest
    // produces a plugin Claude Code cannot compare against anything.
    for (const bad of ['v1.2.3', '1.2', 'latest', '', '01.2.3']) {
      assert.throws(() => setVersion(manifest, bad), /not a semantic version/);
    }
  });

  it('rewrites a manifest that is all on one line', () => {
    // Anchoring the match to the start of a line would report this as having
    // no version at all.
    assert.equal(
      setVersion('{"name":"x","version":"1.0.0"}', '1.1.0'),
      '{"name":"x","version":"1.1.0"}'
    );
  });

  it('refuses a nested version key rather than rewriting it', () => {
    // The failure this guards against is silent: substituting the nested
    // version leaves the manifest's own version stale, and the plugin then
    // publishes under a number nothing else agrees with.
    const nested = manifest.replace(
      '  "license": "MIT"',
      '  "peer": {\n    "version": "1.0.0"\n  }'
    );

    assert.throws(() => setVersion(nested, '3.0.0'), /found 2/);
    assert.throws(
      () =>
        setVersion('{"version":"1.0.0","peer":{"version":"2.0.0"}}', '3.0.0'),
      /found 2/
    );
  });

  it('refuses a duplicate version key split across lines', () => {
    // JSON keeps the last of two duplicate keys, so rewriting the first one
    // leaves the effective version untouched — the published manifests would
    // disagree while the script reported success.
    assert.throws(
      () => setVersion('{"version":"1.0.0","version":\n"2.0.0"}', '3.0.0'),
      /found 2/
    );
  });

  it('ignores a "version" key quoted inside a string value', () => {
    // A manifest may describe the thing it does. JSON escapes every quote
    // inside a string, so the raw text reads `\"version\": \"x\"` and the
    // matcher's literal `"version"` — which needs an unescaped quote on both
    // sides of the word — cannot reach it. Pinning that here because the
    // failure it would cause is a release-blocking false "found 2", and a
    // future rewrite of the matcher is exactly what would reintroduce it.
    const described = [
      '{',
      '  "name": "dispatch",',
      '  "description": "writes \\"version\\": \\"x\\" into the manifest",',
      '  "version": "0.32.0"',
      '}',
      '',
    ].join('\n');

    assert.equal(
      setVersion(described, '1.0.0'),
      described.replace('"0.32.0"', '"1.0.0"')
    );
  });

  it('refuses a shadowing version key the regex cannot see', () => {
    // `version` is `version` to a JSON parser and invisible to the
    // regex, so the match count looks fine and only the written-value check
    // catches it.
    assert.throws(
      () => setVersion('{"version":"1.0.0","\\u0076ersion":"2.0.0"}', '3.0.0'),
      /left the top-level "version" as "2\.0\.0"/
    );
  });

  it('refuses a file with no version key', () => {
    assert.throws(
      () => setVersion('{"name": "dispatch"}\n', '1.0.0'),
      /no top-level "version" string/
    );
  });

  it('refuses a non-string version', () => {
    assert.throws(
      () => setVersion('{"version": 3}\n', '1.0.0'),
      /no top-level "version" string/
    );
  });

  it('refuses input that is not a JSON object', () => {
    assert.throws(() => setVersion('["version"]\n', '1.0.0'), /version/);
    assert.throws(() => setVersion('not json', '1.0.0'), SyntaxError);
  });

  it('leaves a version containing regex replacement syntax intact', () => {
    // `$&` and `$1` in a replacement string are substitution patterns. The
    // semver guard is what stops one reaching String.replace, so assert the
    // guard rather than trusting the escaping.
    assert.throws(
      () => setVersion(manifest, '1.0.0-$&'),
      /not a semantic version/
    );
  });
});
