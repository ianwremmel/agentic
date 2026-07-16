/**
 * Conventional commits, per the repo convention. The commit-msg hook enforces
 * this locally; CI re-checks every commit on the branch, because a hook only
 * runs for people who ran `npm install`.
 */
export default {
  extends: ['@commitlint/config-conventional'],
};
