import globals from 'globals';

/**
 * The dashboard ships as plain <script> files, not modules, so every source is
 * parsed as a script and the shared layer is a global.
 */
export default [
  {
    ignores: ['node_modules/**', 'test-results/**', 'playwright-report/**', '_site/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // shared.js publishes itself here and every module reads it.
        OwnTone: 'readonly',
      },
    },
    rules: {
      // The rule that would have caught `current is not defined` in renderQueue.
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-redeclare': 'error',
      'no-func-assign': 'error',
      'no-self-assign': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-sparse-arrays': 'error',
      'no-unsafe-negation': 'error',
      'no-async-promise-executor': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      eqeqeq: ['error', 'smart'],
      // Empty catch blocks are used deliberately for optional storage/parsing;
      // require a comment so an accidental one still stands out.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Node scripts: the test server and the Playwright config.
    files: ['tests/static-server.js', 'playwright.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['tests/**/*.spec.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
