import { describe, expect, it } from 'vitest';
import { ISLAND_MAX, mergeTokens, pickArrivals, type IslandToken } from './walletIsland.js';

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
});
