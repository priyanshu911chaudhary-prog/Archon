import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/src/**/*.integration.test.ts', 'apps/**/src/**/*.integration.test.ts'],
    exclude: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/coverage/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
