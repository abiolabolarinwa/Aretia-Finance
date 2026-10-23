/**
 * Builds public/_headers and public/_redirects (what Cloudflare Pages reads) from vercel.json, so the two hosts
 * serve the same redirects and security headers. Run `node scripts/cloudflare-config.ts`; a test fails if they drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface VercelConfig {
  redirects: { source: string; destination: string; permanent: boolean }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

export function cloudflareFiles(vercel: VercelConfig): { headers: string; redirects: string } {
  const redirects = vercel.redirects.map((r) => `${r.source} ${r.destination} ${r.permanent ? 301 : 302}`).join('\n') + '\n';
  const headers =
    vercel.headers
      .map((h) => `${h.source === '/(.*)' ? '/*' : h.source}\n${h.headers.map((x) => `  ${x.key}: ${x.value}`).join('\n')}`)
      .join('\n\n') + '\n';
  return { headers, redirects };
}

const url = (p: string) => new URL(p, import.meta.url);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = cloudflareFiles(JSON.parse(readFileSync(url('../vercel.json'), 'utf8')));
  writeFileSync(url('../public/_headers'), out.headers);
  writeFileSync(url('../public/_redirects'), out.redirects);
  console.log('wrote public/_headers and public/_redirects');
}
