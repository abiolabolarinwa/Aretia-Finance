import { describe, expect, it } from 'vitest';
import { fetchIndexedPages, mergeIndexRows } from './clientRows';
import type { MarketRow } from '../market/types';

const pool = (i: number) => ({
  chain: 'bnb',
  address: `0x${i.toString(16).padStart(40, '0')}`,
  base: { address: `0x${(i + 1_000_000).toString(16).padStart(40, '0')}`, symbol: `T${i}`, name: `Token ${i}`, decimals: 18 },
  quote: { symbol: 'WBNB' },
  createdAt: '2026-10-24T00:00:00Z',
});
const answer = (data: unknown[], nextCursor: string | null) => ({ ok: true, json: async () => ({ data, meta: { nextCursor } }) }) as Response;

describe('fetchIndexedPages', () => {
  it('follows the cursor until the index has no more', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      return u.includes('cursor=b') ? answer([pool(3)], null) : u.includes('cursor=a') ? answer([pool(2)], 'b') : answer([pool(1)], 'a');
    }) as unknown as typeof fetch;
    const rows = await fetchIndexedPages('t1', 0, { fetchImpl });
    expect(rows).toHaveLength(3);
    expect(urls).toHaveLength(3);
  });

  it('stops at the cap', async () => {
    let calls = 0;
    const fetchImpl = (async () => (calls++, answer(Array.from({ length: 100 }, (_, i) => pool(calls * 100 + i)), 'more'))) as unknown as typeof fetch;
    const rows = await fetchIndexedPages('t2', 0, { fetchImpl, max: 250 });
    expect(rows).toHaveLength(250);
    expect(calls).toBe(3);
  });

  it('keeps what it read when a later page fails, and reads nothing twice within a minute', async () => {
    let calls = 0;
    const fetchImpl = (async () => (++calls === 1 ? answer([pool(1)], 'a') : ({ ok: false, status: 503 } as Response))) as unknown as typeof fetch;
    expect(await fetchIndexedPages('t3', 0, { fetchImpl })).toHaveLength(1);
    await fetchIndexedPages('t3', 30_000, { fetchImpl });
    expect(calls).toBe(2);
  });

  it('returns an empty list, not an error, when the index is down', async () => {
    const fetchImpl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await fetchIndexedPages('t4', 0, { fetchImpl })).toEqual([]);
  });
});

describe('mergeIndexRows', () => {
  it('keeps the feed rows first and drops index rows for tokens already listed', () => {
    const row = (chain: string, address: string) => ({ chain, address }) as MarketRow;
    const merged = mergeIndexRows([row('bnb', '0xABC'), row('solana', 'So1')], [row('bnb', '0xabc'), row('solana', 'so1'), row('bnb', '0xdef')]);
    expect(merged.map((r) => r.address)).toEqual(['0xABC', 'So1', 'so1', '0xdef']);
  });
});
