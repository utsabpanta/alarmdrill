import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const WORKSPACE_PACKAGES = ['core', 'injectors', 'observers', 'agents', 'report'];

/**
 * Tests run against package sources, not `dist`, so `pnpm test` never needs a
 * build step first.
 */
const alias = Object.fromEntries(
  WORKSPACE_PACKAGES.map((name) => [
    `@alarmdrill/${name}`,
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
  ]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    clearMocks: true,
    // No test may call a real model or depend on wall-clock timing
    // (SPEC.md, "Decisions already made"). Keep this short on purpose.
    testTimeout: 10_000,
  },
});
