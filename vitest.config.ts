import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each integration file starts its own PostgreSQL container; more than four at once starves
    // them and turns ordinary queries into timeouts.
    maxWorkers: 4,
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/regression/**/*.test.ts',
    ],
  },
});
