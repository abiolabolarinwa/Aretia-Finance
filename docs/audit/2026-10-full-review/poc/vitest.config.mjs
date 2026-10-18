// Runs the web proof-of-concept tests against the website's own code and node_modules:
//   cd website && npx vitest run --config ../docs/audit/2026-10-full-review/poc/vitest.config.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
export default {
  root: join(here, '..', '..', '..', '..', 'website'),
  server: { fs: { strict: false, allow: ['/'] } },
  test: { include: [join(here, '**/*.test.ts')], environment: 'node', globals: true, testTimeout: 60000 },
};
