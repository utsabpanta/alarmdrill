import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const WORKSPACE_PACKAGES = ['core', 'injectors', 'observers', 'agents', 'report'];

const alias = Object.fromEntries(
  WORKSPACE_PACKAGES.map((name) => [
    `@alarmdrill/${name}`,
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
  ]),
);

/**
 * Integration tests need the lab running (`pnpm lab:up`). They are kept out of
 * `pnpm test` so the unit suite stays a sub-second feedback loop.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['packages/*/integration/**/*.integration.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
