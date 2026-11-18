import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimit } from './_rpcProxy.js';
import { handleMarketStats, resetMarketStatsCache } from './_swingsMarketStats.js';
import { handleMarketIntel, resetMarketIntelCache } from './_swingsMarketIntel.js';
import { buildStats } from '../src/swings/mi/marketStats.js';
import type { IntelPool } from '../src/swings/market/intel/common.js';
import type { PoolRecord } from '../src/swings/mi/marketList.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const env = { SUPABASE_URL: 'https://data.example.org', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const h = (chain: string, head: number | null, over: Record<string, unknown> = {}) => ({ adapterId: `a-${chain}-${head}`, chain, head, safeHead: head === null ? null : head - 2, checkpoint: null, lagBlocks: 0, lastRunAt: NOW - 5_000, lastSuccessAt: NOW - 5_000, lastError: null, consecutiveFailures: 0, stats: {}, ...over });

let seq = 0;
/** A pool that passes every check, with the given overrides. */
function pool(o: { chain?: string; vol?: number | null; liq?: number | null; txns?: number | null; traders?: number | null; capped?: boolean; venue?: string | null } = {}): IntelPool {
  seq++;
  const chain = o.chain ?? 'bnb';
  return {
    key: `${chain}:pool${seq}`,
    chain,
    token: `${chain}:token${seq}`,
    venue: o.venue === undefined ? 'Uniswap V3' : o.venue,
    priceUsd: 1,
    liquidityUsd: o.liq === undefined ? 50_000 : o.liq,
    ageMs: 30 * DAY,
    change: { m5: 0, h1: 0, h6: 0, h24: 0 },
    volumeUsd: { m5: null, h1: null, h6: null, h24: o.vol === undefined ? 10_000 : o.vol },
    txns24h: o.txns === undefined ? 100 : o.txns,
    txnsCapped: o.capped === true,
    traders24h: o.traders === undefined ? 40 : o.traders,
  };
}

describe('buildStats', () => {
  it('sums volume and trades per network and in total, and ignores pools with no volume or on an unknown network', () => {
    const s = buildStats(
      [pool({ chain: 'ethereum', vol: 1_000, txns: 10 }), pool({ chain: 'ethereum', vol: 500, txns: 2 }), pool({ chain: 'bnb', vol: 250, txns: 2 }), pool({ chain: 'bnb', vol: 0, txns: 99 }), pool({ chain: 'bnb', vol: null }), pool({ chain: 'dogechain', vol: 9_999 })],
      [],
      NOW,
    );
    expect(s.chains.ethereum).toMatchObject({ volume24hUsd: 1_500, txns24h: 12, pools: 2, latestBlock: null });
    expect(s.chains.bnb).toMatchObject({ volume24hUsd: 250, txns24h: 2, pools: 1 });
    expect(s.total).toEqual({ volume24hUsd: 1_750, txns24h: 14, pools: 3, excludedPools: 0, excludedVolume24hUsd: 0, cappedPools: 0 });
    expect(s.asOf).toBe(NOW);
  });
  it('leaves out wash trading and says how much volume that was: far over liquidity, a few accounts, or a few accounts turning the pool over', () => {
    const s = buildStats(
      [
        pool({ vol: 201_500_000, liq: 1_370_000 }), // 147 times its liquidity
        pool({ vol: 400_000, liq: 1_000_000, txns: 900, traders: 6 }), // 900 trades from 6 accounts
        pool({ vol: 220_290_000, liq: 2_653_000, txns: 1_953, traders: 11 }), // $20M per account on $2.7M of liquidity: each account turned the pool over 7 times
        pool({ vol: 100_000, liq: 1_000_000, txns: 50, traders: 20, capped: true }),
        pool({ vol: 5_000, liq: 500 }), // too little liquidity: not counted, not "left out" either
      ],
      [],
      NOW,
    );
    expect(s.chains.bnb).toMatchObject({ volume24hUsd: 100_000, pools: 1, excludedPools: 3, excludedVolume24hUsd: 201_500_000 + 400_000 + 220_290_000, cappedPools: 1, txns24h: 50 });
    expect(s.total).toMatchObject({ pools: 1, excludedPools: 3, cappedPools: 1 });
  });
  it('counts a pool once', () => {
    const a = pool({ vol: 1_000 });
    const s = buildStats([a, { ...a }, pool({ vol: 2_000 })], [], NOW);
    expect(s.chains.bnb).toMatchObject({ volume24hUsd: 3_000, pools: 2 });
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

/** A pool record as the index stores it. */
const record = (i: number, over: Partial<PoolRecord> = {}): PoolRecord =>
  ({
    key: `bnb:0x${i.toString(16).padStart(40, '0')}`,
    chain: 'bnb',
    address: `0x${i.toString(16).padStart(40, '0')}`,
    adapter_id: 'uniswap-v3-bnb',
    dex: 'x',
    base: `0x${(i + 0x100000).toString(16).padStart(40, '0')}`,
    quote: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    base_decimals: 18,
    created_at: NOW - 40 * DAY,
    last_trade_at: NOW - 60_000,
    liquidity_usd: 80_000,
    vol24_usd: 30_000,
    p_usd: 1.5,
    chg: { m5: 100, h1: 200, h6: 300, h24: 500 },
    buys: { m5: 1, h1: 5, h6: 20, h24: 60 },
    sells: { m5: 1, h1: 4, h6: 15, h24: 50 },
    vol: { m5: 100, h1: 1_000, h6: 10_000, h24: 30_000 },
    ro: false,
    mk: 25,
    cp: false,
    ...over,
  }) as PoolRecord;

describe('GET /api/swings-market?src=stats', () => {
  beforeEach(() => {
    resetMarketStatsCache();
    resetMarketIntelCache();
    resetRateLimit();
  });
  const input = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({ method: 'GET', origin: null, authorization: null, ip: '1.1.1.1', query: { src: 'stats' }, env, fetchImpl, now: NOW, ...over });
  const world = (rows: PoolRecord[] = [record(1)]) => {
    const calls: string[] = [];
    const fetchImpl = (async (u: string) => {
      calls.push(String(u));
      if (String(u).includes('/mi_health')) return new Response(JSON.stringify([{ data: h('ethereum', 500) }]));
      if (String(u).includes('/mi_pools')) {
        const offset = Number(new URL(String(u)).searchParams.get('offset') ?? '0');
        return new Response(JSON.stringify(rows.slice(offset, offset + 1000)));
      }
      return new Response('[]');
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('answers the totals and the latest block, asking only for pools that traded in the day with the liquidity the checks need', async () => {
    const w = world();
    const r = await handleMarketStats(input(w.fetchImpl) as never);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { total: { volume24hUsd: number; txns24h: number }; chains: Record<string, { latestBlock: number }>; stale: boolean };
    expect(body.total).toMatchObject({ volume24hUsd: 30_000, txns24h: 110 });
    expect(body.chains.ethereum!.latestBlock).toBe(500);
    expect(body.stale).toBe(false);
    expect(r.headers['cache-control']).toContain('s-maxage=30');
    const pools = new URL(w.calls.find((c) => c.includes('/mi_pools'))!);
    expect(pools.searchParams.get('vol24_usd')).toBe('gt.0');
    expect(pools.searchParams.getAll('liquidity_usd').join(' ')).toContain('gte.1000');
    expect(pools.searchParams.get('state')).toBe('eq.active');
  });
  it('reads further pages of pools while a page is full, and keeps its answer for 30 seconds', async () => {
    const rows = Array.from({ length: 1_001 }, (_, i) => record(i + 1, { vol24_usd: 100, vol: { m5: 1, h1: 1, h6: 1, h24: 100 } }));
    const w = world(rows);
    const a = JSON.parse((await handleMarketStats(input(w.fetchImpl) as never)).body) as { chains: { bnb: { pools: number } } };
    expect(a.chains.bnb.pools).toBe(1_001);
    expect(w.calls.filter((c) => c.includes('/mi_pools'))).toHaveLength(2);
    await handleMarketStats(input(w.fetchImpl, { now: NOW + 10_000 }) as never);
    expect(w.calls.filter((c) => c.includes('/mi_pools'))).toHaveLength(2); // within 30 seconds: no new request
  });
  it('is one set of pools with the market intelligence answer: the bar total equals the venues total', async () => {
    // One pool traded $5M on $100,000 of liquidity (50 times) from 3 accounts: wash trading by the account rules, left out of both.
    const rows = [...Array.from({ length: 40 }, (_, i) => record(i + 1)), record(99, { vol24_usd: 5_000_000, vol: { m5: 1, h1: 1, h6: 1, h24: 5_000_000 }, liquidity_usd: 100_000, mk: 3 })];
    const w = world(rows);
    const stats = JSON.parse((await handleMarketStats(input(w.fetchImpl) as never)).body) as { total: { volume24hUsd: number; pools: number; excludedVolume24hUsd: number } };
    const intel = JSON.parse((await handleMarketIntel(input(w.fetchImpl, { query: { src: 'intel' } }) as never)).body) as { adv: { totalVolume24hUsd: number; eligiblePools: number; excludedVolume24hUsd: number } };
    expect(stats.total.volume24hUsd).toBe(intel.adv.totalVolume24hUsd);
    expect(stats.total.pools).toBe(intel.adv.eligiblePools);
    expect(stats.total.excludedVolume24hUsd).toBe(intel.adv.excludedVolume24hUsd);
    expect(stats.total.excludedVolume24hUsd).toBe(5_000_000);
    expect(stats.total.pools).toBe(40);
    expect(w.calls.filter((c) => c.includes('/mi_pools'))).toHaveLength(1); // both read the pools once
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
