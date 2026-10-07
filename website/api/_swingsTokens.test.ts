import { describe, expect, it, vi } from 'vitest';
import { CHAIN_IDS } from '../src/swings/core/types';
import { EVM_V2_DEXES } from '../src/swings/dex/entries';
import { handleDiscover, handleTokens, parseFilter, type TokensInput } from './_swingsTokens';

const input = (over: Partial<TokensInput> = {}): TokensInput => ({
  method: 'GET',
  origin: 'https://aretiafinance.org',
  authorization: null,
  ip: '9.9.9.9',
  query: {},
  env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key-not-real', CRON_SECRET: 'cron-not-real' },
  fetchImpl: vi.fn(async () => new Response('[]', { status: 200 })) as unknown as typeof fetch,
  now: 1,
  ...over,
});

describe('token registry API', () => {
  it('lists tokens for an allowed origin and never exposes the service key', async () => {
    const out = await handleTokens(input());
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ tokens: [] });
    expect(JSON.stringify(out)).not.toContain('service-key-not-real');
  });
  it('searches when q is given', async () => {
    expect(JSON.parse((await handleTokens(input({ query: { q: 'abc' } }))).body)).toEqual({ results: [] });
  });
  it('is closed to other origins and methods, and 503 when unconfigured', async () => {
    expect((await handleTokens(input({ origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handleTokens(input({ method: 'POST' }))).status).toBe(405);
    expect((await handleTokens(input({ env: {} }))).status).toBe(503);
  });
  it('does not leak database errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret detail', { status: 500 })) as unknown as typeof fetch;
    const out = await handleTokens(input({ fetchImpl }));
    expect(out.status).toBe(502);
    expect(out.body).not.toContain('secret');
  });
  it('parses filters and ignores junk', () => {
    expect(parseFilter({ chain: 'base', maxAgeHours: '6', minLiquidityUsd: '-5', risk: 'high,safe,elevated', sort: 'volume', limit: '10.7' })).toEqual({ chain: 'base', maxAgeHours: 6, riskStatuses: ['high', 'elevated'], sort: 'volume', limit: 10 });
    expect(parseFilter({ chain: 'doge' })).toEqual({});
  });
});

describe('discovery endpoint', () => {
  it('requires the cron secret', async () => {
    expect((await handleDiscover(input())).status).toBe(401);
    expect((await handleDiscover(input({ authorization: 'Bearer wrong' }))).status).toBe(401);
    expect((await handleDiscover(input({ env: { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y' }, authorization: 'Bearer undefined' }))).status).toBe(401);
  });
  it('runs one worker per chain when authorised, reporting failures instead of hiding them', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const out = await handleDiscover(input({ authorization: 'Bearer cron-not-real', fetchImpl }));
    expect(out.status).toBe(200);
    const { runs } = JSON.parse(out.body) as { runs: { chain: string; error: string | null }[] };
    // One third-party feed per chain, Aretia's own factory feed for each direct V2 venue, then its own Solana feed.
    expect(runs.map((r) => r.chain)).toEqual([...CHAIN_IDS, ...EVM_V2_DEXES.map((e) => e.chain), 'solana']);
    expect(runs.every((r) => r.error !== null)).toBe(true);
  });
});
