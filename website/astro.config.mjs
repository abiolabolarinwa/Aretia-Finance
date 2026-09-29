import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://aretiafinance.org',
  // Emit /features.html rather than /features/index.html so Vercel's
  // cleanUrls serves /features, matching the existing static pages in public/.
  build: { format: 'file' },
  trailingSlash: 'never',
});
