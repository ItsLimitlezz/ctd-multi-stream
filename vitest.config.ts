import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many suites launch Chromium or run Argon2; full parallelism starves them on smaller machines.
    maxWorkers: '50%',
    projects: [
      {
        test: {
          name: 'server',
          include: ['server/src/**/*.test.ts', 'shared/**/*.test.ts', 'scripts/**/*.test.{ts,mjs}'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Web tests use the Vite config (@shared alias, React plugin). Inline projects resolve `include`
        // against the repository root, not the Vite `root: 'web'`, so the glob must start at web/.
        extends: './vite.config.ts',
        test: {
          name: 'web',
          include: ['web/src/**/*.test.{ts,tsx}'],
          environment: 'node',
        },
      },
    ],
  },
});
