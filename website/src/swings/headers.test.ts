import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cfg = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
const header = (k: string): string => cfg.headers.flatMap((h) => h.headers).find((h) => h.key === k)?.value ?? '';
const directive = (policy: string, name: string): string[] => (policy.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) ?? []).slice(1);

describe('security headers', () => {
  it('apply to every page', () => {
    expect(cfg.headers.some((h) => h.source === '/(.*)')).toBe(true);
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('enforce the directives that cannot break a page: no plugins, a fixed base, no foreign framing, forms only to ourselves and the contact service', () => {
    const p = header('Content-Security-Policy');
    expect(directive(p, 'object-src')).toEqual(["'none'"]);
    expect(directive(p, 'base-uri')).toEqual(["'self'"]);
    expect(directive(p, 'frame-ancestors')).toEqual(["'self'"]);
    expect(directive(p, 'form-action')).toEqual(["'self'", 'https://formspree.io']);
  });

  it('report the full policy without blocking yet, and that policy allows no eval, no wildcard script host and no plain http', () => {
    const p = header('Content-Security-Policy-Report-Only');
    expect(p).not.toBe('');
    expect(directive(p, 'default-src')).toEqual(["'self'"]);
    const scripts = directive(p, 'script-src');
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts.filter((s) => s === '*' || s.startsWith('http:') || s.includes('*'))).toEqual([]);
    expect(p).not.toMatch(/\bhttp:\/\//);
    expect(directive(p, 'connect-src')).toContain('https://iris-api.circle.com');
    expect(directive(p, 'frame-src')).toContain('https://buy.moonpay.com');
  });
});
