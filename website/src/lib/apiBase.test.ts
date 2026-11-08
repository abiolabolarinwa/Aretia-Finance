import { describe, expect, it } from 'vitest';
import { apiShimScript } from './apiBase';

function run(base: string, calls: unknown[]): unknown[] {
  const seen: unknown[] = [];
  const win = { fetch: (i: unknown) => (seen.push(i), Promise.resolve(new Response('{}'))), location: { origin: 'https://localhost' } };
  const script = apiShimScript(base)!;
  new Function('window', 'URL', 'Request', script)(win, URL, Request);
  for (const c of calls) void win.fetch(c as never);
  return seen;
}

describe('apiShimScript', () => {
  it('adds nothing on the website', () => {
    expect(apiShimScript(undefined)).toBeNull();
    expect(apiShimScript('  ')).toBeNull();
  });
  it('refuses an address that is not an https origin', () => {
    expect(() => apiShimScript('http://example.com')).toThrow();
    expect(() => apiShimScript('https://example.com/path')).toThrow();
  });
  it('sends relative api calls to the configured address and leaves other calls alone', () => {
    const seen = run('https://aretiafinance.org/', ['/api/swings-market?x=1', '/assets/a.png', 'https://api.dexscreener.com/x', new URL('https://localhost/api/swings-data?route=a')]);
    expect(seen[0]).toBe('https://aretiafinance.org/api/swings-market?x=1');
    expect(seen[1]).toBe('/assets/a.png');
    expect(seen[2]).toBe('https://api.dexscreener.com/x');
    expect(String(seen[3])).toBe('https://aretiafinance.org/api/swings-data?route=a');
  });
  it('rewrites a Request for a same-origin api path', () => {
    const seen = run('https://aretiafinance.org', [new Request('https://localhost/api/swings-account', { method: 'POST', body: '{}' })]);
    expect((seen[0] as Request).url).toBe('https://aretiafinance.org/api/swings-account');
    expect((seen[0] as Request).method).toBe('POST');
  });
});
