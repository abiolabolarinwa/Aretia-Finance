import { describe, expect, it } from 'vitest';
import { agoText, blocksFor, fetchMarketStats, statsFor, STATS_URL, type MarketStatsDto } from './marketStats.js';

const NOW = 1_800_000_000_000;
const stats: MarketStatsDto = {
  asOf: NOW,
  total: { volume24hUsd: 700, txns24h: 90, pools: 5 },
  chains: {
    ethereum: { volume24hUsd: 500, txns24h: 60, pools: 3, latestBlock: 26_400_000, blockSeenAt: NOW - 2_000 },
    bnb: { volume24hUsd: 200, txns24h: 30, pools: 2, latestBlock: 133_000_000, blockSeenAt: NOW - 90_000 },
    base: { volume24hUsd: 0, txns24h: 0, pools: 0, latestBlock: 55_000_000, blockSeenAt: NOW - 4_000 },
    polygon: { volume24hUsd: 0, txns24h: 0, pools: 0, latestBlock: null, blockSeenAt: null },
  },
};

describe('the stats bar numbers', () => {
  it('gives the totals for all networks, or one network’s own, and nothing when the index has none', () => {
    expect(statsFor(stats, '')).toEqual({ volume24hUsd: 700, txns24h: 90, pools: 5 });
    expect(statsFor(stats, 'bnb')).toEqual({ volume24hUsd: 200, txns24h: 30, pools: 2 });
    expect(statsFor(stats, 'base')).toBeNull();
    expect(statsFor(stats, 'solana')).toBeNull();
    expect(statsFor(null, '')).toBeNull();
  });
  it('lists the latest block of the chosen network, or one per network with the busiest first', () => {
    expect(blocksFor(stats, 'bnb')).toEqual([{ chain: 'bnb', block: 133_000_000, seenAt: NOW - 90_000 }]);
    expect(blocksFor(stats, '').map((b) => b.chain)).toEqual(['ethereum', 'bnb', 'base']); // polygon has no block; base trades least
    expect(blocksFor(stats, 'polygon')).toEqual([]);
    expect(blocksFor(null, '')).toEqual([]);
  });
  it('says how long ago in plain words, and nothing when unknown', () => {
    expect(agoText(NOW - 2_000, NOW)).toBe('2s ago');
    expect(agoText(NOW - 90_000, NOW)).toBe('2 min ago');
    expect(agoText(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(agoText(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
    expect(agoText(NOW + 5_000, NOW)).toBe('0s ago');
    expect(agoText(null, NOW)).toBe('');
  });
  it('fetches the index stats, and is null (no bar, no error) when it is unreachable or answers nonsense', async () => {
    const answer = (body: unknown, ok = true) => (async (u: string) => { expect(u).toBe(STATS_URL); return new Response(JSON.stringify(body), { status: ok ? 200 : 500 }); }) as unknown as typeof fetch;
    expect(await fetchMarketStats(answer(stats))).toEqual(stats);
    expect(await fetchMarketStats(answer({ error: 'index' }))).toBeNull();
    expect(await fetchMarketStats(answer({ asOf: 1 }))).toBeNull();
    expect(await fetchMarketStats(answer(stats, false))).toBeNull();
    expect(await fetchMarketStats((async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });
});
