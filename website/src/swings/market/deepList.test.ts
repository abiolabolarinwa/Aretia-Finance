import { beforeEach, describe, expect, it } from 'vitest';
import { fetchDeepRows, resetDeepList } from './deepList';
import type { MarketRow } from './types';

const rows = (chain: string, page: number, n = 20) =>
  Array.from({ length: n }, (_, i) => ({ chain, address: `${chain}-${page}-${i}`, volume24hUsd: 1000 - page * 20 - i }) as unknown as MarketRow);
const reply = (r: MarketRow[]) => ({ ok: true, json: async () => ({ rows: r }) }) as Response;

beforeEach(resetDeepList);

describe('fetchDeepRows', () => {
  it('reaches over a thousand tokens by walking ten pages of every network', async () => {
    const fetchImpl = (async (u: string) => {
      const q = new URL(u, 'https://x').searchParams;
      return reply(rows(q.get('chain')!, Number(q.get('page'))));
    }) as unknown as typeof fetch;
    const got = await fetchDeepRows('', 'h24', 0, { fetchImpl });
    expect(got.length).toBeGreaterThanOrEqual(1000);
    expect(new Set(got.map((r) => r.address)).size).toBe(got.length);
    expect(got[0]!.volume24hUsd!).toBeGreaterThanOrEqual(got[got.length - 1]!.volume24hUsd!);
  });

  it('asks one network only when one is chosen, and stops at a short page', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (u: string) => {
      const q = new URL(u, 'https://x').searchParams;
      asked.push(`${q.get('chain')}:${q.get('page')}`);
      return reply(rows('bnb', Number(q.get('page')), Number(q.get('page')) > 2 ? 1 : 20));
    }) as unknown as typeof fetch;
    const got = await fetchDeepRows('bnb', 'h24', 0, { fetchImpl });
    expect(new Set(asked.map((a) => a.split(':')[0]))).toEqual(new Set(['bnb']));
    expect(got.length).toBeGreaterThanOrEqual(40);
    expect(asked.length).toBeLessThan(10);
  });

  it('skips pages that fail and keeps the rest, and reuses a recent answer', async () => {
    let calls = 0;
    const fetchImpl = (async (u: string) => {
      calls++;
      if (calls % 2 === 0) return { ok: false, status: 429 } as Response;
      const q = new URL(u, 'https://x').searchParams;
      return reply(rows(q.get('chain')!, Number(q.get('page'))));
    }) as unknown as typeof fetch;
    const first = await fetchDeepRows('base', 'h24', 0, { fetchImpl, pages: 4 });
    expect(first.length).toBeGreaterThan(0);
    const before = calls;
    await fetchDeepRows('base', 'h24', 60_000, { fetchImpl, pages: 4 });
    expect(calls).toBe(before);
  });
});
