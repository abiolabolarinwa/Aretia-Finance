import { defineConfig } from 'vitest/config';

// Read-only checks against real public services. Run with `npm run test:live`. Never part of `npm test`:
// they need the network and can fail because a third party is down or changed.
export default defineConfig({
  test: {
    include: ['src/**/*.live.ts'],
    environment: 'node',
    testTimeout: 180_000,
  },
});
