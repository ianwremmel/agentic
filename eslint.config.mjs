import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import {defineConfig, globalIgnores} from 'eslint/config';
import js from '@eslint/js';
import markdown from '@eslint/markdown';
import prettier from 'eslint-plugin-prettier/recommended';
import * as jsonc from 'jsonc-eslint-parser';
import tseslint from 'typescript-eslint';
import * as yaml from 'yaml-eslint-parser';

export default defineConfig([
  globalIgnores(['node_modules/', 'coverage/', 'package-lock.json']),

  {
    files: ['**/*.{mjs,mts}'],
    extends: [
      js.configs.recommended,
      comments.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', 'commitlint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Every write and log call is async; a dropped promise is a silent hole in
      // the CLI's output. node:test's `describe`/`it` are the exception: the
      // runner owns those promises and awaits them itself, and awaiting them at
      // the call site is wrong (a promise returned from a `describe` body is
      // treated as the suite's result).
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {from: 'package', package: 'node:test', name: ['describe', 'it']},
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // The CLI writes to the streams it is handed; console bypasses them.
      'no-console': 'error',
    },
  },

  {
    files: ['**/*.md'],
    extends: [markdown.configs.recommended],
    language: 'markdown/gfm',
    rules: {
      // The spec and skill docs fence wire-format payloads, log lines, and
      // directory trees — content with no language to name.
      'markdown/fenced-code-language': 'warn',
    },
  },

  // JSON and YAML get a parser purely so Prettier can reach them through
  // ESLint: with no `format` script, `eslint --fix` is the only formatter, and
  // it can only fix files it can parse.
  {
    files: ['**/*.json'],
    languageOptions: {parser: jsonc},
  },
  {
    files: ['**/*.{yml,yaml}'],
    languageOptions: {parser: yaml},
  },

  // Prettier last: it turns off every stylistic rule the formatter owns.
  prettier,
]);
