// Local only: `npx vite --config dev/aretia-pool-harness/vite.config.ts`, then open http://localhost:4392/aretia-pool-harness/
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  root: here('..'),
  publicDir: here('../../public'),
  // Outside the OneDrive folder, whose sync locks break the dependency cache.
  cacheDir: 'C:/cargo-target/vite-cache',
  server: { port: 4392, strictPort: true, fs: { allow: [here('../..')] } },
  define: { global: 'globalThis' },
});
