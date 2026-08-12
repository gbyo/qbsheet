import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  // The last three are generated: a lint run after a browser-test run would otherwise spend its
  // time reporting on Playwright's own bundled report viewer.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.stryker-tmp/**',
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
      // eslint-plugin-react-hooks 7 folded the React Compiler rules into its recommended set. Most
      // of them pass here already and stay on; these three flag 21 existing sites whose fixes are
      // real changes to how effects and refs behave, not lint noise, so they are deferred to their
      // own change rather than smuggled into a dependency bump.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
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
      'scripts/**/*.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The generated service worker source is a template string, not a module this config can parse.
    files: ['src/pwa/**/*.ts'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
);
