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
  it('keeps the security headers and the five redirects', () => {
    expect(out.headers).toContain('/*\n  Content-Security-Policy: ');
    expect(out.headers).toContain('X-Content-Type-Options: nosniff');
    expect(out.redirects.trim().split('\n')).toHaveLength(5);
  });
});
