import { defineConfig } from 'vitest/config';

// Real transactions on devnet with a funded keypair. Run with `npm run test:curve-devnet`. Never part of `npm test`.
export default defineConfig({
  test: {
    include: ['src/**/*.devnet.ts'],
    environment: 'node',
    testTimeout: 600_000,
  },
});
