import { beforeEach, describe, expect, it } from 'vitest';
import { readList, type ListQuery, type PoolRecord, type Reader } from '../marketList';
import { jupiterRanking, resetRankingMemory } from './ranking';

const NOW = 1_800_000_000_000;
const SOL = 'So11111111111111111111111111111111111111112';
const mint = (i: number): string => `Mint${String(i).padStart(4, '0')}`.padEnd(44, 'x');
const token = (i: number, over: Record<string, unknown> = {}) => ({ id: mint(i), liquidity: 90_000, holderCount: 100, audit: { freezeAuthorityDisabled: true }, ...over });

/** A Jupiter that returns the given list for every ranking request and records the addresses asked. */
function jupiter(list: unknown, status = 200) {
  const urls: { url: string; key: string | null }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    urls.push({ url, key: new Headers(init?.headers).get('x-api-key') });
    return new Response(JSON.stringify(list), { status });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe('the Jupiter ranking', () => {
  beforeEach(resetRankingMemory);

  it('asks the right list for each view, in Jupiter order, and keeps it for two minutes', async () => {
    const { impl, urls } = jupiter([token(3), token(1), token(2), token(1)]);
    const rank = jupiterRanking(impl, () => NOW);
    const a = (await rank('top', 'h24'))!;
    expect(a.mints).toEqual([mint(3), mint(1), mint(2)]); // repeats dropped
    await rank('top', 'h24');
    expect(urls).toHaveLength(1);
    await rank('trending', 'h1');
    expect(urls[1]!.url).toContain('/toptrending/1h?limit=100');
    expect(urls[0]!.url).toContain('/toptraded/24h?limit=100');
    await jupiterRanking(impl, () => NOW + 3 * 60_000)('top', 'h24');
    expect(urls).toHaveLength(3);
  });

  it('puts a key in a header, not the address, and uses the keyed service only then', async () => {
    const { impl, urls } = jupiter([token(1)]);
    await jupiterRanking(impl, () => NOW, undefined, 'secret-key')('top', 'h24');
    expect(urls[0]!.url).toContain('https://api.jup.ag/');
    expect(urls[0]!.url).not.toContain('secret-key');
    expect(urls[0]!.key).toBe('secret-key');
  });

  it('serves the last list for an hour when Jupiter refuses, then nothing, and pauses asking for a minute', async () => {
    await jupiterRanking(jupiter([token(1)]).impl, () => NOW)('top', 'h24');
    const refuse = jupiter([], 429);
    const rank = (at: number) => jupiterRanking(refuse.impl, () => at);
    expect((await rank(NOW + 10 * 60_000)('top', 'h24'))!.mints).toEqual([mint(1)]);
    expect(await rank(NOW + 10 * 60_000 + 5_000)('top', 'h24')).not.toBeNull();
    expect(refuse.urls).toHaveLength(1); // paused after the refusal
    expect(await rank(NOW + 2 * 3_600_000)('top', 'h24')).toBeNull();
    expect(await rank(NOW + 2 * 3_600_000)('trending', 'h6')).toBeNull(); // never had that one
  });
});

const q = (over: Partial<ListQuery> = {}): ListQuery => ({ kind: 'top', chain: 'solana', window: 'h24', sort: 'rank', dir: 'desc', page: 1, size: 50, minLiquidityUsd: 1000, maxAgeHours: 0, ...over });
const pool = (mintId: string, n: number, liquidity: number): PoolRecord => ({
  key: `solana:Pool${n}`,
  chain: 'solana',
  address: `Pool${n}`,
  adapter_id: 'meteora-damm-v2-solana',
  dex: 'meteora',
  base: mintId,
  quote: SOL,
  base_decimals: 6,
  created_at: NOW - 3_600_000,
  liquidity_usd: liquidity,
  vol24_usd: 100,
  p_usd: 0.5,
  chg: { m5: 1, h1: 2, h6: 3, h24: 4 },
  buys: { m5: 1, h1: 5, h6: 20, h24: 60 },
  sells: { m5: 1, h1: 4, h6: 18, h24: 50 },
  vol: { m5: 1, h1: 5, h6: 20, h24: 100 },
  ro: false,
});
function reader(pools: PoolRecord[], asked: string[] = [], symbols: Record<string, string> = {}): Reader {
  return {
    async get(path) {
      asked.push(path);
      if (path.startsWith('mi_tokens')) {
        const keys = [...path.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        return { rows: keys.map((key) => ({ key, symbol: symbols[key.replace('solana:', '')] ?? `T${key.slice(7, 15)}`, name: 'n', decimals: 6 })), total: null };
      }
      return { rows: pools, total: pools.length };
    },
  };
}
const never = async () => new Map();

describe('Solana Top and Trending ranked by Jupiter', () => {
  beforeEach(resetRankingMemory);

  it("lists Jupiter's tokens in Jupiter's order, each as the index's deepest pool of the token, and says how many it has", async () => {
    const { impl } = jupiter([token(5), token(2), token(9), token(7)]); // 9 has no pool in the index
    const asked: string[] = [];
    const pools = [pool(mint(2), 1, 400_000), pool(mint(5), 2, 90_000), pool(mint(5), 3, 900_000), pool(mint(7), 4, 20_000)];
    const a = await readList(reader(pools, asked), q(), NOW, never, jupiterRanking(impl, () => NOW));
    expect(a.rows.map((r) => r.address)).toEqual([mint(5), mint(2), mint(7)]);
    expect(a.rows[0]!.pool).toBe('Pool2'); // the first pool read for the token is the deepest, as the database orders them
    expect(a.note).toContain('3 of Jupiter');
    expect(a.total).toBe(3);
    const poolRead = asked.find((p) => p.startsWith('mi_pools'))!;
    expect(poolRead).toContain('base=in.(');
    expect(poolRead).toContain('order=liquidity_usd.desc');
  });

  it("drops a token Jupiter itself lists but cannot be bought: flagged, drained or freezable; and repeats of a symbol", async () => {
    const { impl } = jupiter([token(1), token(2, { liquidity: 0.5 }), token(3, { audit: { isSus: true } }), token(4, { audit: { freezeAuthorityDisabled: false } }), token(5), token(6)]);
    const pools = [1, 2, 3, 4, 5, 6].map((i) => pool(mint(i), i, 50_000));
    const symbols = { [mint(5)]: 'WIF', [mint(6)]: 'wif' };
    const a = await readList(reader(pools, [], symbols), q(), NOW, never, jupiterRanking(impl, () => NOW));
    expect(a.rows.map((r) => r.address)).toEqual([mint(1), mint(5)]);
  });

  it('asks the 24-hour list for Top whatever the window, and the chosen window for Trending', async () => {
    const { impl, urls } = jupiter([token(1)]);
    const rank = jupiterRanking(impl, () => NOW);
    const pools = [pool(mint(1), 1, 50_000)];
    await readList(reader(pools), q({ kind: 'top', window: 'h1' }), NOW, never, rank);
    await readList(reader(pools), q({ kind: 'trending', window: 'h6' }), NOW, never, rank);
    expect(urls.map((u) => u.url.replace(/^.*tokens\/v2\//, ''))).toEqual(['toptraded/24h?limit=100', 'toptrending/6h?limit=100']);
  });

  it("falls back to the index's own ranking when Jupiter cannot be reached, or none of its tokens are in the index", async () => {
    const pools = [pool(mint(8), 1, 50_000)];
    const down = jupiterRanking(jupiter([], 500).impl, () => NOW);
    const a = await readList(reader(pools), q(), NOW, async () => new Map([[mint(8), { liquidityUsd: 50_000, suspicious: false, freezeOff: true, holders: 5 }]]), down);
    expect(a.rows.map((r) => r.address)).toEqual([mint(8)]);
    resetRankingMemory();
    const none = jupiterRanking(jupiter([token(1)]).impl, () => NOW);
    const b = await readList(reader(pools), q(), NOW, async () => new Map([[mint(8), { liquidityUsd: 50_000, suspicious: false, freezeOff: true, holders: 5 }]]), none);
    expect(b.rows.map((r) => r.address)).toEqual([mint(8)]);
  });

  it('leaves other views, other networks and custom sorts on the index ranking', async () => {
    const { impl, urls } = jupiter([token(1)]);
    const rank = jupiterRanking(impl, () => NOW);
    const pools = [pool(mint(1), 1, 50_000)];
    await readList(reader(pools), q({ kind: 'new' }), NOW, never, rank);
    await readList(reader(pools), q({ kind: 'liquidity' }), NOW, never, rank);
    await readList(reader(pools), q({ sort: 'volume' }), NOW, never, rank);
    await readList(reader(pools), q({ chain: 'bnb' }), NOW, never, rank);
    expect(urls).toHaveLength(0);
  });
});
