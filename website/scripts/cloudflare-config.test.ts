import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cloudflareFiles } from './cloudflare-config';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('Cloudflare Pages config', () => {
  const out = cloudflareFiles(JSON.parse(read('../vercel.json')));
  it('public/_headers and _redirects match vercel.json (run node scripts/cloudflare-config.ts)', () => {
    expect(read('../public/_headers')).toBe(out.headers);
    expect(read('../public/_redirects')).toBe(out.redirects);
  });
  it('keeps the security headers, the five redirects and the clean wallet token path', () => {
    expect(out.headers).toContain('/*\n  Content-Security-Policy: ');
    expect(out.headers).toContain('X-Content-Type-Options: nosniff');
    const lines = out.redirects.trim().split('\n');
    expect(lines.filter((l) => l.endsWith(' 301') || l.endsWith(' 302'))).toHaveLength(5);
    // /wallet/app stays a redirect and comes first; any other /wallet/<chain>/<address> serves the wallet page.
    expect(lines.indexOf('/wallet/app /wallet 302')).toBeLessThan(lines.indexOf('/wallet/:chain/:address /wallet 200'));
    expect(lines).toContain('/wallet/:chain/:address /wallet 200');
  });
});
