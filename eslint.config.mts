import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import js from '@eslint/js';
import markdown from '@eslint/markdown';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['node_modules'] },

  // TypeScript sources. Type-aware linting via the project service, so rules
  // like no-floating-promises can see across modules.
  {
    files: ['**/*.mts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      comments.recommended,
      prettier,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An eslint-disable must say why, so a reader can judge whether it still
      // applies.
      '@eslint-community/eslint-comments/require-description': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
    },
  },

  {
    files: ['**/*.test.mts'],
    rules: {
      // `describe` and `it` return promises that the node:test runner awaits
      // itself. Awaiting them in the test file is neither required nor correct.
      '@typescript-eslint/no-floating-promises': 'off',
      // Tests index into arrays they have just built (`nodes[0]?.role`). The
      // optional chain is what `noUncheckedIndexedAccess` demands and tsc
      // enforces; this rule reads the same access as non-nullish and disagrees.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  // Markdown: structural lint. Prose formatting is deliberately not enforced —
  // the spec's hand-padded tables are a repo convention (CLAUDE.md) that a
  // formatter would rewrite.
  {
    files: ['**/*.md'],
    extends: [markdown.configs.recommended],
    language: 'markdown/gfm',
    rules: {
      // Most fences in the spec hold ASCII state diagrams, log-line formats,
      // and wire formats. There is no language to name, and tagging them all
      // `text` would be noise.
      'markdown/fenced-code-language': 'off',
    },
  },
);
