/**
 * Switching the data service by environment variables only (server/README.md, website/docs/self-hosted-data-server.md):
 * what the site sends to a PostgREST server behind Caddy is what it sends to Supabase.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';
import { resetBudgets } from './_limits.js';
import { handleMi, resetMiCache } from './_marketIndexer.js';
import { signKey } from '../../server/bin/make-keys.mjs';

beforeEach(() => {
  resetMiCache();
  resetBudgets();
});

describe('the data service address and key', () => {
  it('accepts the self-hosted server\'s https address and refuses plain http or a path', () => {
    expect(supabaseBase('https://data.aretiafinance.org')).toBe('https://data.aretiafinance.org');
    expect(supabaseBase('data.aretiafinance.org/rest/v1/')).toBe('https://data.aretiafinance.org');
    expect(supabaseBase('http://data.aretiafinance.org')).toBeNull();
  });
  it('a key made by server/bin/make-keys.mjs is sent as apikey and as Bearer, which is what the Caddy entry requires', () => {
    const key = signKey('s3cret-for-test', 'service_role') as string;
    expect(supabaseHeaders(key)).toEqual({ apikey: key, authorization: `Bearer ${key}` });
  });
});

describe('MI_DATA_URL: the indexer tables on their own data service', () => {
  const run = async (env: Record<string, string>) => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await handleMi({ method: 'GET', query: { path: 'status' }, authorization: null, ip: '9.9.9.9', env, fetchImpl, now: 1_800_000_000_000 });
    return urls;
  };
  const both = { SUPABASE_URL: 'https://old.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'eyJold' };

  it('reads from Supabase as before when it is not set', async () => {
    const urls = await run(both);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('https://old.supabase.co/rest/v1/mi_'))).toBe(true);
  });
  it('reads from the new server when both MI_DATA_URL and its key are set', async () => {
    const urls = await run({ ...both, MI_DATA_URL: 'https://data.example.org', MI_DATA_SERVICE_ROLE_KEY: 'eyJnew' });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('https://data.example.org/rest/v1/mi_'))).toBe(true);
  });
  it('ignores a half-set pair (a URL without its key never sends the old key to the new address)', async () => {
    const urls = await run({ ...both, MI_DATA_URL: 'https://data.example.org' });
    expect(urls.every((u) => u.startsWith('https://old.supabase.co/'))).toBe(true);
  });
});
