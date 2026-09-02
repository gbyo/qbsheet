import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // The last three are generated: a lint run after a browser-test run would otherwise spend its
  // time reporting on Playwright's own bundled report viewer.
  {
    ignores: [
      'dist/**',
      '**/dist/**',
      'node_modules/**',
      '**/node_modules/**',
      '**/target/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.claude/worktrees/**',
      '.stryker-tmp/**',
      // Wrangler's local dev bundle. Generated, and not ours to lint.
      '**/.wrangler/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      // A scorekeeper drives this with a keyboard as often as with a touchscreen, and the dialogs
      // are the part most easily got wrong.
      ...jsxA11y.flatConfigs.recommended.rules,
      // Nothing in this repository takes an untyped value on purpose except at the file and network
      // boundaries, and those hand it straight to a validator.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Prop types are the TypeScript interface; the runtime checker would be a second, weaker copy.
      'react/prop-types': 'off',
    },
  },
  {
    // Build and test tooling runs in Node.
    files: [
      'vite.config.ts',
      'vitest.config.ts',
      'playwright.config.ts',
      'eslint.config.js',
      'tests/**/*.{ts,tsx}',
      'e2e/**/*.{ts,tsx}',
      // `.mjs` as well as `.ts`: the scripts here are run by `node` directly rather than compiled,
      // and one that reports what it wrote needs `console` to exist.
      'scripts/**/*.{ts,mjs}',
      '**/scripts/**/*.{ts,mjs}',
      'packages/*/tests/**/*.ts',
      'packages/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      'apps/*/test/**/*.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Cloudflare Workers. Not Node and not a browser: `workerd` supplies the web platform globals
    // and its own `crypto`, and the runtime types come from `@cloudflare/workers-types`.
    files: ['apps/qblive-backend-cloudflare/src/**/*.ts', 'apps/qblive-push*/src/**/*.ts'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
    rules: {
      // The vendored protocol copy is generated; its lint status is the original's.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['apps/qblive-backend-cloudflare/src/env.d.ts'],
    rules: { '@typescript-eslint/no-empty-object-type': 'off' },
  },
  {
    // The generated service worker source is a template string, not a module this config can parse.
    files: ['src/pwa/**/*.ts'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
  // Last, so it wins: this turns off every rule about how the code looks. Prettier decides that now,
  // and a lint error nobody can fix by hand — because the formatter will put it straight back — is
  // worse than no rule at all.
  prettier,
);
