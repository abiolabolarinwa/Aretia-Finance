import { describe, expect, it } from 'vitest';
import { ISLAND_MAX, mergeTokens, pickArrivals, selectNewest, type IslandToken } from './walletIsland.js';

const tok = (n: number): IslandToken => ({ key: `base:0x${n}`, chain: 'base', address: `0x${n}`, symbol: `T${n}`, name: `Token ${n}`, icon: null, priceUsd: 1, liquidityUsd: 1, capUsd: 1, ageMs: 1, rating: null });

describe('island', () => {
  it('finds the tokens that were not seen before, in order', () => {
    const seen = new Set([tok(1).key, tok(3).key]);
    expect(pickArrivals([tok(4), tok(3), tok(2), tok(1)], seen).map((t) => t.symbol)).toEqual(['T4', 'T2']);
    expect(pickArrivals([], seen)).toEqual([]);
  });
  it('puts new tokens first, keeps each token once, and caps the list', () => {
    expect(mergeTokens([tok(3), tok(1)], [tok(2), tok(1)]).map((t) => t.symbol)).toEqual(['T3', 'T1', 'T2']);
    const many = Array.from({ length: 30 }, (_, i) => tok(i));
    expect(mergeTokens(many, [])).toHaveLength(ISLAND_MAX);
  });
  it('shows the newest of every network under six hours old, youngest first, and skips dust, unpriced and older pools', () => {
    const H = 3_600_000;
    const t = (n: number, chain: IslandToken['chain'], ageMs: number | null, liq = 5000, price: number | null = 1): IslandToken => ({ ...tok(n), key: `${chain}:${n}`, chain, ageMs, liquidityUsd: liq, priceUsd: price });
    const all = [t(1, 'base', 5000), t(2, 'base', 1000), t(3, 'base', 9000), t(4, 'solana', 20_000), t(5, 'robinhood', 3 * 24 * H), t(6, 'solana', 100, 10), t(7, 'bnb', 500, 5000, null), t(8, 'bnb', null), t(9, 'polygon', 5.9 * H), t(10, 'polygon', 6.1 * H), t(11, 'ethereum', 6 * H)];
    const got = selectNewest(all);
    // base keeps its two newest (2 then 1); solana's dust pool and robinhood's 3-day-old one are out, as are the unpriced and the unknown-age bnb pools
    expect(got.map((x) => x.key)).toEqual(['base:2', 'base:1', 'solana:4', 'polygon:9', 'ethereum:11']);
    expect(selectNewest([])).toEqual([]);
  });
});
