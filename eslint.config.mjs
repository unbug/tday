// @ts-check
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

export default tseslint.config(
  // ── Ignored paths ────────────────────────────────────────────────────────
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      '**/build/**',
      '**/*.cjs',
      '**/*.mjs',
      'scripts/**',
      'crates/**',
    ],
  },

  // ── All TypeScript / TSX files ───────────────────────────────────────────
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
      'react': react,
    },
    rules: {
      'prefer-const': ['warn', { destructuring: 'all' }],
      'no-var': 'warn',
      'no-debugger': 'warn',
      'no-duplicate-imports': 'warn',
      'no-eval': 'error',
      '@typescript-eslint/no-explicit-any': ['warn', { fixToUnknown: false }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ── Renderer: Settings sub-files must not import upward ──────────────────
  // Mirrors VS Code's code-layering / code-import-patterns approach:
  // enforce architecture by restricting what can be imported, not by capping
  // line counts.
  {
    files: ['apps/desktop/src/renderer/src/Settings/**/*.{ts,tsx}'],
    ignores: ['apps/desktop/src/renderer/src/Settings/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Sections / widgets must never reach up into App or the root renderer
              group: ['../App', '../App.*', '../../*'],
              message:
                'Settings sub-files must not import from parent renderer layers. ' +
                'Pass data down via props from Settings.tsx instead.',
            },
            {
              // Sections must not cross-import peer Sections.
              // (A Section may import a Widget it owns — e.g. CronSection → ScheduleWidget.)
              group: [
                './*Section',
                './*Section.*',
              ],
              message:
                'Section files must not import peer Section files. ' +
                'Extract shared logic into *-helpers.ts or shared.tsx.',
            },
          ],
        },
      ],
    },
  },

  // ── Renderer: orchestrators must contain no business logic ───────────────
  {
    files: [
      'apps/desktop/src/renderer/src/Settings.tsx',
      'apps/desktop/src/renderer/src/App.tsx',
    ],
    rules: {
      // Orchestrators pass props down; they must not call raw fetch/IPC
      // directly except through the established window.tday bridge.
      // This is a documentation-level reminder; structural violations are
      // caught by TypeScript and code review.
      'no-restricted-globals': [
        'warn',
        { name: 'fetch', message: 'Use window.tday IPC bridge instead of raw fetch in orchestrators.' },
      ],
    },
  },

  // ── Helpers and hooks: no JSX ─────────────────────────────────────────────
  {
    files: [
      'apps/desktop/src/renderer/src/**/*-helpers.ts',
      'apps/desktop/src/renderer/src/hooks/**/*.ts',
      'apps/desktop/src/renderer/src/Settings/types.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXElement',
          message: 'Helper and hook files must not contain JSX. Move UI into a *Section.tsx or *Widget.tsx file.',
        },
        {
          selector: 'JSXFragment',
          message: 'Helper and hook files must not contain JSX. Move UI into a *Section.tsx or *Widget.tsx file.',
        },
      ],
    },
  },

  // ── Silence unknown rule references from inline eslint-disable comments ──
  {
    files: ['**/*.{ts,tsx}'],
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
  },

  // ── Tests ────────────────────────────────────────────────────────────────
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-imports': 'off',
    },
  },
);
