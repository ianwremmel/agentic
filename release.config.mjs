/**
 * semantic-release owns the published version of `@ianwremmel/dispatch`. The
 * root package is private and never publishes.
 *
 * Tags are package-scoped (`dispatch-v1.2.3`) because this repo is a
 * marketplace: a bare `v1.2.3` would have to be shared by whatever becomes
 * publishable next, and the format cannot be changed once releases exist.
 * `dispatch-v0.32.0` is tagged on the last hand-published commit — the merge
 * *before* the one that added this file, so that commit's own `feat:` counts
 * toward the first automated release. Without that tag semantic-release would
 * start at 1.0.0 and declare a stability the plugin does not have.
 *
 * The `conventionalcommits` preset is not cosmetic. The default `angular`
 * preset does not read the `!` breaking-change marker, so `feat!: …` — which
 * `@commitlint/config-conventional` accepts, and which this repo therefore
 * lets through — resolves to no release at all under it. The preset has to
 * match the convention commitlint enforces or breaking changes ship silently
 * as nothing. It is pinned to 9.x on purpose: 10.x requires
 * `conventional-changelog-writer@9`, and `@semantic-release/release-notes-generator`
 * brings 8, which makes note generation throw on every release.
 *
 * Recovering a half-finished release: semantic-release pushes the tag after
 * `prepare` (so after the manifest commit) and before `publish`. A failure in
 * between leaves git advertising a version npm never received, and re-running
 * finds that tag, sees nothing newer, and publishes nothing. Delete the remote
 * tag and revert the `chore(release):` commit, then re-run the workflow.
 *
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: ['main'],
  tagFormat: 'dispatch-v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', {preset: 'conventionalcommits'}],
    [
      '@semantic-release/release-notes-generator',
      {preset: 'conventionalcommits'},
    ],
    // Writes the version into plugins/dispatch/package.json, then publishes
    // that directory.
    ['@semantic-release/npm', {pkgRoot: 'plugins/dispatch'}],
    // The same version into the plugin manifest beside it. Every plugin's
    // `prepare` runs before any plugin's `publish`, so both manifests are
    // written before the tarball is packed and a published artifact cannot
    // carry two different numbers.
    [
      '@semantic-release/exec',
      {
        prepareCmd:
          'node scripts/set-plugin-version.mts ${nextRelease.version} plugins/dispatch/.claude-plugin/plugin.json',
      },
    ],
    // Commit both manifests back to main. Installing this plugin through the
    // marketplace reads `plugin.json` straight from git (marketplace.json
    // sources ./plugins/dispatch), and Claude Code decides whether an install
    // is stale by comparing that version — so leaving it behind in git would
    // freeze every marketplace consumer on whatever they first installed.
    // `[skip ci]` in the message, and GitHub's own rule that a GITHUB_TOKEN
    // push triggers no workflow, both stop this from retriggering the release.
    //
    // The push is a plain `git push HEAD:main`, so it needs `main`'s ruleset to
    // let it through: the rule requiring a pull request rejects it unless
    // GitHub Actions is on that ruleset's bypass list. A rejection here fails
    // the run during `prepare`, before the tag exists and before anything
    // publishes, so it costs a red job and nothing more.
    [
      '@semantic-release/git',
      {
        assets: [
          'plugins/dispatch/package.json',
          'plugins/dispatch/.claude-plugin/plugin.json',
        ],
        message: 'chore(release): dispatch ${nextRelease.version} [skip ci]',
      },
    ],
    '@semantic-release/github',
  ],
};
