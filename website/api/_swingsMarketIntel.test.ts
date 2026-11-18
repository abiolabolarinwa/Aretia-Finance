import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimit } from './_rpcProxy.js';
import { handleMarketIntel, resetMarketIntelCache } from './_swingsMarketIntel.js';
import { handleMarket } from './_swingsMarket.js';
import { buildSnapshot, rowOf } from '../src/swings/market/intel/snapshot.js';
import { fromMarketRow } from '../src/swings/market/intel/common.js';
import { historyPaths, poolsPath, readIntelPools } from '../src/swings/market/intel/read.js';
import { postgrestReader, rowFromRecord, type PoolRecord } from '../src/swings/mi/marketList.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const env = { SUPABASE_URL: 'https://data.example.org', SUPABASE_SERVICE_ROLE_KEY: 'k' };

/** A pool record as the index stores it: changes in basis points, every window traded. */
const record = (i: number, over: Partial<PoolRecord> = {}): PoolRecord =>
  ({
    key: `bnb:0x${i.toString(16).padStart(40, 'c')}`,
    chain: 'bnb',
    address: `0x${i.toString(16).padStart(40, 'c')}`,
    adapter_id: i % 3 === 0 ? 'pancakeswap-v2-bnb' : 'uniswap-v3-bnb',
    dex: 'x',
    base: `0x${i.toString(16).padStart(40, 'a')}`,
    quote: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    base_decimals: 18,
    created_at: NOW - 40 * DAY,
    last_trade_at: NOW - 60_000,
    liquidity_usd: 80_000,
    vol24_usd: 30_000,
    p_usd: 1.5,
    chg: { m5: 100, h1: 200, h6: 300, h24: i % 4 === 0 ? -500 : 500 },
    buys: { m5: 1, h1: 5, h6: 20, h24: 60 },
    sells: { m5: 1, h1: 4, h6: 15, h24: 50 },
    vol: { m5: 100, h1: 1_000, h6: 10_000, h24: 30_000 },
    ro: false,
    mk: 25,
    cp: false,
    ...over,
  }) as PoolRecord;

const records = (n: number): PoolRecord[] => Array.from({ length: n }, (_, i) => record(i + 1));

function world(opts: { pools?: PoolRecord[]; snapshots?: unknown[]; failPools?: boolean } = {}) {
  const calls: string[] = [];
  const pools = opts.pools ?? records(60);
  const fetchImpl = (async (u: string) => {
    calls.push(String(u));
    if (String(u).includes('/mi_pools')) {
      if (opts.failPools) return new Response('no', { status: 500 });
      const offset = Number(new URL(String(u)).searchParams.get('offset') ?? '0');
      return new Response(JSON.stringify(pools.slice(offset, offset + 1000)));
    }
    if (String(u).includes('/mi_market_snapshots')) return new Response(JSON.stringify(opts.snapshots ?? []));
    return new Response('[]');
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const input = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({ method: 'GET', origin: null, authorization: null, ip: '1.1.1.1', query: { src: 'intel' }, env, fetchImpl, now: NOW, ...over });

describe('reading the engine inputs', () => {
  it('asks for active, traded, liquid pools busiest first, a page at a time, and turns records into engine pools', async () => {
    const path = new URL(`https://x/rest/v1/${poolsPath(2, NOW)}`);
    expect(path.searchParams.get('state')).toBe('eq.active');
    expect(path.searchParams.get('vol24_usd')).toBe('gt.0');
    expect(path.searchParams.get('offset')).toBe('2000');
    expect(path.searchParams.get('last_trade_at')).toBe(`gte.${NOW - DAY}`);
    const w = world({ pools: records(5) });
    const pools = await readIntelPools(postgrestReader('https://data.example.org', {}, w.fetchImpl), NOW);
    expect(pools).toHaveLength(5);
    expect(pools[0]).toMatchObject({ chain: 'bnb', venue: 'PancakeSwap V2' === pools[0]!.venue ? 'PancakeSwap V2' : 'Uniswap V3', liquidityUsd: 80_000 });
    expect(pools[0]!.change.h24).toBe(5);
    expect(w.calls.filter((c) => c.includes('/mi_pools'))).toHaveLength(1); // a short page ends the read
  });
  it('reads the history of a scope from two requests', () => {
    const paths = historyPaths('bnb', NOW);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain('scope=eq.bnb');
    expect(paths[1]).toContain('or=(and(at.gte.');
  });
});

describe('GET /api/swings-market?src=intel', () => {
  beforeEach(() => {
    resetMarketIntelCache();
    resetRateLimit();
  });

  it('answers the mood, the rising/falling split of every window, and the venues, with confidence and the history it had', async () => {
    const w = world();
    const r = await handleMarketIntel(input(w.fetchImpl) as never);
    expect(r.status).toBe(200);
    const b = JSON.parse(r.body) as { scope: string; ammi: { status: string; score: number | null }; arf: Record<string, { eligible: number; rising: number; falling: number; neutral: number }>; adv: { venues: { venue: string; share: number }[]; totalVolume24hUsd: number }; confidence: { arf: { level: string } }; history: { days: number }; stale: boolean };
    expect(b.scope).toBe('all');
    expect(b.stale).toBe(false);
    expect(b.arf.h24!.eligible).toBe(60);
    expect(b.arf.h24!.rising + b.arf.h24!.falling + b.arf.h24!.neutral).toBe(60);
    expect(b.arf.h24!.falling).toBe(15);
    expect(b.ammi.status).toBe('provisional');
    expect(b.ammi.score).toBeGreaterThan(50);
    expect(b.adv.totalVolume24hUsd).toBe(60 * 30_000);
    expect(b.adv.venues.reduce((s, v) => s + v.share, 0)).toBeCloseTo(100, 6);
    expect(b.history.days).toBe(0);
    expect(r.headers['cache-control']).toContain('s-maxage=60');
  });

  it('uses stored snapshots for volume growth and the volume part of the mood', async () => {
    const pools = records(60).map((rec) => fromMarketRow(rowFromRecord(rec, new Map(), NOW)!)!);
    const rows = [] as unknown[];
    for (let k = 1; k <= 7; k++) rows.push(rowOf(buildSnapshot(pools, 'all', NOW - k * DAY)));
    const w = world({ snapshots: rows });
    const b = JSON.parse((await handleMarketIntel(input(w.fetchImpl) as never)).body) as { ammi: { components: { V: { used: boolean } } }; adv: { venues: { growth: number | null }[] }; history: { days: number; venueGrowth: boolean } };
    expect(b.history.days).toBe(7);
    expect(b.history.venueGrowth).toBe(true);
    expect(b.ammi.components.V.used).toBe(true);
    expect(b.adv.venues[0]!.growth).toBeCloseTo(0, 6); // the same volume a day ago
  });

  it('works one network out, refuses an unknown one, and keeps an answer for a minute', async () => {
    const w = world();
    const one = JSON.parse((await handleMarketIntel(input(w.fetchImpl, { query: { src: 'intel', chain: 'bnb' } }) as never)).body) as { scope: string; arf: { h24: { eligible: number } } };
    expect(one.scope).toBe('bnb');
    expect(one.arf.h24.eligible).toBe(60);
    const none = JSON.parse((await handleMarketIntel(input(w.fetchImpl, { query: { src: 'intel', chain: 'solana' } }) as never)).body) as { ammi: { score: number | null }; arf: { h24: { risingPct: number | null } } };
    expect(none.ammi.score).toBeNull();
    expect(none.arf.h24.risingPct).toBeNull();
    expect((await handleMarketIntel(input(w.fetchImpl, { query: { src: 'intel', chain: 'dogechain' } }) as never)).status).toBe(400);
    const before = w.calls.length;
    await handleMarketIntel(input(w.fetchImpl, { query: { src: 'intel', chain: 'bnb' } }) as never);
    expect(w.calls.length).toBe(before); // from the kept answer
    const pageReads = w.calls.filter((c) => c.includes('/mi_pools')).length;
    expect(pageReads).toBe(1); // the pools were read once for both networks
  });

  it('is routed from /api/swings-market and only by GET', async () => {
    const w = world();
    const routed = await handleMarket(input(w.fetchImpl) as never);
    expect(routed.status).toBe(200);
    expect(JSON.parse(routed.body).scope).toBe('all');
    expect((await handleMarketIntel(input(w.fetchImpl, { method: 'POST' }) as never)).status).toBe(405);
  });

  it('answers with an error flag, not a figure, when the database is down or not configured, and serves the kept answer when it was kept', async () => {
    expect(JSON.parse((await handleMarketIntel(input(world().fetchImpl, { env: {} }) as never)).body)).toEqual({ error: 'not-configured' });
    expect(JSON.parse((await handleMarketIntel(input(world({ failPools: true }).fetchImpl) as never)).body)).toEqual({ error: 'index' });
    resetMarketIntelCache();
    const good = world();
    await handleMarketIntel(input(good.fetchImpl) as never);
    const later = await handleMarketIntel(input(world({ failPools: true }).fetchImpl, { now: NOW + 5 * 60_000 }) as never);
    const b = JSON.parse(later.body) as { stale: boolean; scope: string };
    expect(b.stale).toBe(true);
    expect(b.scope).toBe('all');
  });
});
