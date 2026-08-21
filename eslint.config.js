// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The blinding boundary. `observers` builds the evidence bundle the
 * diagnostician sees; if anything from `injectors` reaches it, the tool starts
 * grading systems on knowledge no on-call engineer would have — and it fails
 * silently. Restructure rather than disable this rule (CLAUDE.md, hard rule 1).
 */
const BLINDING = [
  'packages/observers must never import packages/injectors — ground truth about',
  'the injected fault would leak into the evidence bundle. See SPEC.md, "Blinding".',
].join(' ');

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'],
  },

  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },

  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Time is a measured output here — it flows through core's Clock.
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Use Clock.setTimer / Clock.sleep from @alarmdrill/core.' },
        { name: 'setInterval', message: 'Use Clock.setTimer from @alarmdrill/core.' },
      ],
    },
  },

  {
    files: ['packages/observers/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@alarmdrill/injectors', message: BLINDING }],
          patterns: [
            {
              group: ['@alarmdrill/injectors/**', '**/injectors', '**/injectors/**'],
              message: BLINDING,
            },
          ],
        },
      ],
    },
  },

  {
    // core owns the Clock implementation, so it is the one place allowed to
    // touch the platform timers it wraps. The lab is the system under test
    // rather than part of the measurement, so its timers are its own business.
    files: [
      'packages/core/src/clock.ts',
      'apps/lab/**/*.ts',
      // Integration harnesses poll real systems for real elapsed time; there is
      // no injected clock that can make a container start faster.
      'packages/*/integration/**/*.ts',
    ],
    rules: { 'no-restricted-globals': 'off' },
  },
);
