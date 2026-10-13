import { describe, expect, it } from 'vitest';
import { ago, KEEP_MS, KEEP_ROWS, KEEP_VIEWS, listKey, readList, retryDelayMs, saveList } from './walletListCache.js';
import type { MarketRow } from '../swings/market/types.js';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const row = (n: number) => ({ chain: 'solana', address: `A${n}`, symbol: `T${n}` }) as unknown as MarketRow;
const key = (n = 1) => listKey({ kind: 'trending', chain: 'solana', window: 'h24', page: n });

describe('the last good Markets list', () => {
  it('is kept and read back, and an empty list is not kept', () => {
    const s = mem();
    saveList(s, key(), [row(1), row(2)], 1000);
    expect(readList(s, key(), 2000)?.rows).toHaveLength(2);
    saveList(s, key(2), [], 1000);
    expect(readList(s, key(2), 2000)).toBeNull();
  });
  it('is not offered once it is more than a day old', () => {
    const s = mem();
    saveList(s, key(), [row(1)], 0);
    expect(readList(s, key(), KEEP_MS)).not.toBeNull();
    expect(readList(s, key(), KEEP_MS + 1)).toBeNull();
  });
  it('keeps a bounded number of rows and views, the newest', () => {
    const s = mem();
    saveList(s, key(), Array.from({ length: 100 }, (_, i) => row(i)), 1);
    expect(readList(s, key(), 2)?.rows).toHaveLength(KEEP_ROWS);
    for (let i = 2; i < KEEP_VIEWS + 5; i++) saveList(s, key(i), [row(i)], i);
    expect(readList(s, key(1), 100)).toBeNull();
    expect(readList(s, key(KEEP_VIEWS + 4), 100)).not.toBeNull();
  });
  it('survives damaged or missing storage', () => {
    const s = mem();
    s.setItem('aretia-market-lists-v1', '{nope');
    expect(readList(s, key(), 1)).toBeNull();
    expect(readList(null, key(), 1)).toBeNull();
    expect(() => saveList(null, key(), [row(1)], 1)).not.toThrow();
  });
  it('says how old it is and spaces its retries out', () => {
    expect(ago(0, 20_000)).toBe('just now');
    expect(ago(0, 5 * 60_000)).toBe('5 min ago');
    expect(ago(0, 3 * 3_600_000)).toBe('3 h ago');
    expect([0, 1, 2, 3, 9].map(retryDelayMs)).toEqual([8000, 15000, 30000, 60000, 60000]);
  });
});
