import { describe, expect, it } from 'vitest';
import { supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';
import { handleRecords } from './_swingsRecords.js';
import { handleTokens } from './_swingsTokens.js';

describe('Supabase keys', () => {
  it('sends the older JWT-style key as apikey and Bearer, and the newer secret key as apikey only', () => {
    expect(supabaseHeaders('eyJhbGciOi.payload.sig')).toEqual({ apikey: 'eyJhbGciOi.payload.sig', authorization: 'Bearer eyJhbGciOi.payload.sig' });
    expect(supabaseHeaders('sb_secret_abc')).toEqual({ apikey: 'sb_secret_abc' });
  });

  it('the recovery service uses the right form for a new-style key', async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => (seen.push(init!.headers as Record<string, string>), new Response('[]'))) as unknown as typeof fetch;
    await handleRecords({ method: 'GET', origin: 'https://aretiafinance.org', ip: '7.7.7.7', contentType: null, query: { id: 'x_' + 'a'.repeat(32) }, body: '', env: { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc' }, fetchImpl, now: 1 });
    expect(seen[0]).toMatchObject({ apikey: 'sb_secret_abc' });
    expect(seen[0]).not.toHaveProperty('authorization');
  });

  it('the token service tells the page the database status code (never the body) when it fails', async () => {
    const fetchImpl = (async () => new Response('{"message":"secret detail"}', { status: 401 })) as unknown as typeof fetch;
    const out = await handleTokens({ method: 'GET', origin: 'https://aretiafinance.org', ip: '8.8.8.8', query: {}, env: { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc' }, fetchImpl, now: 1 } as never);
    expect(out.status).toBe(502);
    expect(JSON.parse(out.body)).toMatchObject({ error: 'database', status: 401 });
    expect(out.body).not.toContain('secret detail');
  });
});

import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';

describe('supabaseBase', () => {
  it('adds https:// when it was left off, and tidies quotes, spaces, slashes and /rest/v1', () => {
    expect(supabaseBase('xlwfcixknqlzudginsin.supabase.co')).toBe('https://xlwfcixknqlzudginsin.supabase.co');
    expect(supabaseBase('  "https://abc.supabase.co/"  ')).toBe('https://abc.supabase.co');
    expect(supabaseBase('https://abc.supabase.co/rest/v1')).toBe('https://abc.supabase.co');
    expect(supabaseBase("'abc.supabase.co/rest/v1/'")).toBe('https://abc.supabase.co');
  });

  it('keeps only the host, so a pasted link cannot point requests elsewhere, and refuses plain http and nonsense', () => {
    expect(supabaseBase('https://abc.supabase.co/dashboard/project/x?token=1')).toBe('https://abc.supabase.co');
    expect(supabaseBase('http://abc.supabase.co')).toBeNull();
    expect(supabaseBase('')).toBeNull();
    expect(supabaseBase(undefined)).toBeNull();
    expect(supabaseBase('localhost')).toBeNull();
    expect(supabaseBase('not a url at all')).toBeNull();
  });

  it('the services now work with a host-only setting', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => (urls.push(String(u)), new Response('[]'))) as unknown as typeof fetch;
    const out = await handleTokens({ method: 'GET', origin: 'https://aretiafinance.org', ip: '9.9.9.1', query: {}, env: { SUPABASE_URL: 'xlwfcixknqlzudginsin.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc' }, fetchImpl, now: 1 } as never);
    expect(out.status).toBe(200);
    expect(urls[0]).toMatch(/^https:\/\/xlwfcixknqlzudginsin\.supabase\.co\/rest\/v1\/token_registry/);
  });
});
