import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimit } from './_rpcProxy.js';
import { handleCandles } from './_swingsCandles.js';
import { buildCandles } from '../src/swings/market/candles.js';

const POOL = 'Pool1111111111111111111111111111111111111111';
const NOW = 1_800_000_000_000;

function input(query: Record<string, string>, fetchImpl: typeof fetch, over: Partial<Parameters<typeof handleCandles>[0]> = {}) {
  return {
    method: 'GET',
    origin: 'https://aretiafinance.org',
    authorization: null,
    ip: '1.1.1.1',
    query,
    env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' },
    fetchImpl,
    now: NOW,
    ...over,
  };
}

describe('candles from recorded prices', () => {
  beforeEach(() => resetRateLimit());

  it('groups readings into buckets, ignores bad prices, and leaves gaps as gaps', () => {
    const c = buildCandles(
      [
        { ts: 3_600_000 * 5 + 60_000, price: 2 },
        { ts: 3_600_000 * 5 + 10_000, price: 1 },
        { ts: 3_600_000 * 5 + 120_000, price: 3 },
        { ts: 3_600_000 * 9, price: 4 },
        { ts: 3_600_000 * 9 + 1, price: -1 },
        { ts: Number.NaN, price: 1 },
      ],
      3_600_000,
    );
    expect(c).toEqual([
      { t: 3_600_000 * 5, o: 1, h: 3, l: 1, c: 3, n: 3 },
      { t: 3_600_000 * 9, o: 4, h: 4, l: 4, c: 4, n: 1 },
    ]);
  });

  it('answers with candles, and marks the pool as watched', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('pool_ticks')) return new Response(JSON.stringify([{ ts: NOW - 5000, price: 1.5 }, { ts: NOW - 4000, price: 2 }]));
      return new Response('');
    }) as unknown as typeof fetch;
    const out = await handleCandles(input({ chain: 'solana', pool: POOL, tf: '15m' }, fetchImpl));
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as { candles: { o: number; c: number }[]; since: number };
    expect(body.candles).toHaveLength(1);
    expect(body.candles[0]).toMatchObject({ o: 1.5, c: 2 });
    expect(body.since).toBe(NOW - 5000);
    expect(seen.some((s) => s.startsWith('POST') && s.includes('tracked_pools'))).toBe(true);
  });

  it('lower-cases an EVM pool but not a Solana one', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response('[]');
    }) as unknown as typeof fetch;
    await handleCandles(input({ chain: 'base', pool: '0x' + 'AB'.repeat(20) }, fetchImpl));
    expect(urls[0]).toContain(`pool=eq.0x${'ab'.repeat(20)}`);
  });

  it('refuses a bad pool, an unknown chain, a bad interval, a foreign origin and a missing database', async () => {
    const never = (async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    expect((await handleCandles(input({ chain: 'solana', pool: 'a;drop' }, never))).status).toBe(400);
    expect((await handleCandles(input({ chain: 'nope', pool: POOL }, never))).status).toBe(400);
    expect((await handleCandles(input({ chain: 'solana', pool: POOL, tf: '2m' }, never))).status).toBe(400);
    expect((await handleCandles(input({ chain: 'solana', pool: POOL }, never, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handleCandles(input({ chain: 'solana', pool: POOL }, never, { env: {} }))).status).toBe(503);
  });

  it('does not leak the database error', async () => {
    const fetchImpl = (async () => new Response('secret detail', { status: 500 })) as unknown as typeof fetch;
    const out = await handleCandles(input({ chain: 'solana', pool: POOL }, fetchImpl));
    expect(out.status).toBe(502);
    expect(out.body).not.toContain('secret');
  });
});
