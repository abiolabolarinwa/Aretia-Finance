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
