import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimit } from './_rpcProxy.js';
import { handleMarketStats, resetMarketStatsCache } from './_swingsMarketStats.js';
import { buildStats } from '../src/swings/mi/marketStats.js';

const NOW = 1_800_000_000_000;
const env = { SUPABASE_URL: 'https://data.example.org', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const h = (chain: string, head: number | null, over: Record<string, unknown> = {}) => ({ adapterId: `a-${chain}-${head}`, chain, head, safeHead: head === null ? null : head - 2, checkpoint: null, lagBlocks: 0, lastRunAt: NOW - 5_000, lastSuccessAt: NOW - 3_000, lastError: null, consecutiveFailures: 0, stats: {}, ...over });

describe('buildStats', () => {
  it('sums volume and trades per network and in total, and ignores pools with no trade or on an unknown network', () => {
    const s = buildStats(
      [
        { chain: 'ethereum', vol24_usd: 1_000, buys: { h24: 6 }, sells: { h24: 4 } },
        { chain: 'ethereum', vol24_usd: 500, buys: { h24: 1 }, sells: { h24: 1 } },
        { chain: 'bnb', vol24_usd: 250, buys: { h24: 2 }, sells: null },
        { chain: 'bnb', vol24_usd: 0, buys: { h24: 99 }, sells: { h24: 99 } },
        { chain: 'bnb', vol24_usd: null },
        { chain: 'dogechain', vol24_usd: 9_999 },
      ],
      [],
      NOW,
    );
    expect(s.chains.ethereum).toMatchObject({ volume24hUsd: 1_500, txns24h: 12, pools: 2, latestBlock: null });
    expect(s.chains.bnb).toMatchObject({ volume24hUsd: 250, txns24h: 2, pools: 1 });
    expect(s.total).toEqual({ volume24hUsd: 1_750, txns24h: 14, pools: 3, excludedPools: 0, excludedVolume24hUsd: 0, cappedPools: 0 });
    expect(s.asOf).toBe(NOW);
  });
  it('leaves out a pool trading over 100 times its liquidity, says so, and counts pools whose window was capped', () => {
    const s = buildStats(
      [
        { chain: 'bnb', vol24_usd: 201_500_000, buys: { h24: 900 }, sells: { h24: 900 }, liquidity_usd: 1_370_000 },
        { chain: 'bnb', vol24_usd: 100_000, buys: { h24: 50 }, sells: { h24: 50 }, liquidity_usd: 1_000_000, cp: true },
        { chain: 'bnb', vol24_usd: 100 * 1_000, buys: { h24: 1 }, sells: { h24: 1 }, liquidity_usd: 1_000 },
        { chain: 'bnb', vol24_usd: 5_000, buys: { h24: 3 }, sells: { h24: 3 }, liquidity_usd: null },
      ],
      [],
      NOW,
    );
    expect(s.chains.bnb).toMatchObject({ volume24hUsd: 205_000, pools: 3, excludedPools: 1, excludedVolume24hUsd: 201_500_000, cappedPools: 1, txns24h: 100 + 2 + 6 });
    expect(s.total).toMatchObject({ pools: 3, excludedPools: 1, cappedPools: 1 });
  });
  it('does not count a pool whose liquidity is beyond any real pool, whatever its volume', () => {
    const s = buildStats(
      [
        { chain: 'robinhood', vol24_usd: 50_000_000, buys: { h24: 11 }, sells: { h24: 11 }, liquidity_usd: 2_200_000_000 },
        { chain: 'robinhood', vol24_usd: 1_000, buys: { h24: 3 }, sells: { h24: 2 }, liquidity_usd: 40_000 },
      ],
      [],
      NOW,
    );
    expect(s.chains.robinhood).toMatchObject({ volume24hUsd: 1_000, pools: 1, excludedPools: 0 });
  });
  it('takes the newest block each network has been seen at, and when', () => {
    const s = buildStats([], [h('ethereum', 100), h('ethereum', 130, { lastSuccessAt: NOW - 1_000 }), h('ethereum', 120), h('solana', 9_000), h('base', null), h('nope', 5)] as never, NOW);
    expect(s.chains.ethereum).toMatchObject({ latestBlock: 130, blockSeenAt: NOW - 1_000 });
    expect(s.chains.solana?.latestBlock).toBe(9_000);
    expect(s.chains.base).toBeUndefined();
    expect(Object.keys(s.chains)).not.toContain('nope');
  });
  it('falls back to the safe head, and to the last run when there was no success', () => {
    const s = buildStats([], [h('polygon', null, { safeHead: 77, lastSuccessAt: null })] as never, NOW);
    expect(s.chains.polygon).toMatchObject({ latestBlock: 77, blockSeenAt: NOW - 5_000 });
  });
});

describe('GET /api/swings-market?src=stats', () => {
  beforeEach(() => {
    resetMarketStatsCache();
    resetRateLimit();
  });
  const input = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({ method: 'GET', origin: null, authorization: null, ip: '1.1.1.1', query: { src: 'stats' }, env, fetchImpl, now: NOW, ...over });
  const world = (rows: unknown[] = [{ chain: 'ethereum', vol24_usd: 10, buys: { h24: 1 }, sells: { h24: 2 } }]) => {
    const calls: string[] = [];
    const fetchImpl = (async (u: string) => {
      calls.push(String(u));
      if (String(u).includes('/mi_health')) return new Response(JSON.stringify([{ data: h('ethereum', 500) }]));
      return new Response(JSON.stringify(rows));
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('answers the totals and the latest block, asking only for pools with a trade above the liquidity floor', async () => {
    const w = world();
    const r = await handleMarketStats(input(w.fetchImpl) as never);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { total: { volume24hUsd: number; txns24h: number }; chains: Record<string, { latestBlock: number }>; stale: boolean };
    expect(body.total).toMatchObject({ volume24hUsd: 10, txns24h: 3 });
    expect(body.chains.ethereum!.latestBlock).toBe(500);
    expect(body.stale).toBe(false);
    expect(r.headers['cache-control']).toContain('s-maxage=30');
    const pools = new URL(w.calls.find((c) => c.includes('/mi_pools'))!);
    expect(pools.searchParams.get('vol24_usd')).toBe('gt.0');
    expect(pools.searchParams.get('liquidity_usd')).toBe('gte.100');
    expect(pools.searchParams.get('state')).toBe('eq.active');
  });
  it('reads further pages of pools while a page is full, and keeps its answer for 30 seconds', async () => {
    const full = Array.from({ length: 1000 }, () => ({ chain: 'bnb', vol24_usd: 1, buys: { h24: 1 }, sells: { h24: 0 } }));
    let pageCalls = 0;
    const fetchImpl = (async (u: string) => {
      if (String(u).includes('/mi_health')) return new Response('[]');
      pageCalls++;
      return new Response(JSON.stringify(pageCalls === 1 ? full : [{ chain: 'bnb', vol24_usd: 1, buys: { h24: 1 }, sells: { h24: 0 } }]));
    }) as unknown as typeof fetch;
    const a = JSON.parse((await handleMarketStats(input(fetchImpl) as never)).body) as { chains: { bnb: { pools: number } } };
    expect(a.chains.bnb.pools).toBe(1001);
    expect(pageCalls).toBe(2);
    await handleMarketStats(input(fetchImpl, { now: NOW + 10_000 }) as never);
    expect(pageCalls).toBe(2); // within 30 seconds: no new request
  });
  it('serves the last answer, marked stale, when the database fails, and an error flag when it never had one', async () => {
    const failing = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect(JSON.parse((await handleMarketStats(input(failing) as never)).body)).toEqual({ error: 'index' });
    await handleMarketStats(input(world().fetchImpl) as never);
    const r = await handleMarketStats(input(failing, { now: NOW + 120_000 }) as never);
    expect(JSON.parse(r.body).stale).toBe(true);
  });
  it('is not configured without a database, refuses other methods, and limits a flood', async () => {
    expect(JSON.parse((await handleMarketStats(input(world().fetchImpl, { env: {} }) as never)).body)).toEqual({ error: 'not-configured' });
    expect((await handleMarketStats(input(world().fetchImpl, { method: 'POST' }) as never)).status).toBe(405);
    let last = 0;
    for (let i = 0; i < 400; i++) {
      resetMarketStatsCache();
      last = (await handleMarketStats(input(world().fetchImpl, { ip: '9.9.9.9' }) as never)).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});
