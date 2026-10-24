import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { refuse, viaCloudflare } from './_proxyGuard';

describe('the API is reachable only through the Cloudflare forwarder when REQUIRE_CF_PROXY=1', () => {
  const on = { CF_PROXY_SECRET: 's3cret-value', REQUIRE_CF_PROXY: '1' };

  it('is off unless both settings are present, so an existing deployment keeps working', () => {
    expect(viaCloudflare({}, {})).toBe(true);
    expect(viaCloudflare({}, { CF_PROXY_SECRET: 's3cret-value' })).toBe(true);
    expect(viaCloudflare({}, { REQUIRE_CF_PROXY: '1' })).toBe(true);
    expect(viaCloudflare({}, { CF_PROXY_SECRET: 's3cret-value', REQUIRE_CF_PROXY: '0' })).toBe(true);
  });

  it('refuses a direct request with no secret, a wrong secret or an empty one', () => {
    expect(viaCloudflare({}, on)).toBe(false);
    expect(viaCloudflare({ 'x-aretia-proxy-secret': 'nope' }, on)).toBe(false);
    expect(viaCloudflare({ 'x-aretia-proxy-secret': '' }, on)).toBe(false);
    expect(viaCloudflare({ 'x-aretia-proxy-secret': 's3cret-valu' }, on)).toBe(false);
    expect(viaCloudflare({ 'x-aretia-proxy-secret': 's3cret-value ' }, on)).toBe(false);
  });

  it('serves the forwarder, which sends the secret (as a string or a one-item array)', () => {
    expect(viaCloudflare({ 'x-aretia-proxy-secret': 's3cret-value' }, on)).toBe(true);
    expect(viaCloudflare({ 'x-aretia-proxy-secret': ['s3cret-value'] }, on)).toBe(true);
  });

  it('lets an exempt caller (a scheduled job with its own bearer secret) through', () => {
    expect(viaCloudflare({}, on, true)).toBe(true);
  });

  it('refuses with 403, a fixed body and no caching', () => {
    const seen: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
    const res = { status(c: number) { seen.status = c; return res; }, setHeader(k: string, v: string) { seen.headers[k] = v; }, send(b: string) { seen.body = b; } };
    refuse(res);
    expect(seen.status).toBe(403);
    expect(seen.body).toBe('{"error":"forbidden"}');
    expect(seen.headers['cache-control']).toBe('no-store');
  });

  it('every public function file checks the guard, so a new endpoint cannot forget it', () => {
    const dir = new URL('.', import.meta.url);
    const handlers = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'));
    expect(handlers.length).toBeGreaterThan(5);
    const missing = handlers.filter((f) => !/viaCloudflare\(req\.headers/.test(readFileSync(new URL(f, dir), 'utf8')));
    expect(missing).toEqual([]);
  });
});
