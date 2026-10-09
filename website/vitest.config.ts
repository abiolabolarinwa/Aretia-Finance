import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'api/**/*.test.ts'],
    environment: 'node',
    // A few venue tests build real transactions; under a full parallel run they need more than the 5 second default.
    testTimeout: 60_000,
  },
});
