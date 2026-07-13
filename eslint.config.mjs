import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import {defineConfig, globalIgnores} from 'eslint/config';
import js from '@eslint/js';
import markdown from '@eslint/markdown';
import prettier from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['node_modules/', 'coverage/']),

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
        projectService: {allowDefaultProject: ['eslint.config.mjs']},
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Every write and log call is async; a dropped promise is a silent hole in
      // the CLI's output. Tests await their suites rather than exempt them.
      '@typescript-eslint/no-floating-promises': 'error',
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

  // Prettier last: it turns off every stylistic rule the formatter owns.
  prettier,
]);
