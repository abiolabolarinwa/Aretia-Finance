import { beforeEach, describe, expect, it } from 'vitest';
import { fetchIndexPage, indexCovers, indexUrl, INDEX_MIN_TOTAL, loadPageSize, pageButtons, resetPageSizeMemory, savePageSize, serverSort, showingText } from './pagedList';
import type { MarketRow } from './types';

const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const row = (n: number) => ({ chain: 'bnb', address: `a${n}`, source: 'index' }) as unknown as MarketRow;
const req = { kind: 'top' as const, chain: 'bnb' as const, window: 'h24' as const, page: 2, size: 50, minLiquidityUsd: 1000 };

beforeEach(resetPageSizeMemory);

describe('indexUrl', () => {
  it('asks for one page with the liquidity filter, so the server counts right', () => {
    const u = new URL(indexUrl(req), 'https://x.test');
    expect(u.pathname).toBe('/api/swings-market');
    expect(Object.fromEntries(u.searchParams)).toEqual({ src: 'index', kind: 'top', window: 'h24', page: '2', size: '50', minLiq: '1000', chain: 'bnb' });
  });
  it('adds a sort and an age only when asked', () => {
    const u = new URL(indexUrl({ ...req, sort: 'liquidity', dir: 'asc', maxAgeHours: 24 }), 'https://x.test');
    expect(u.searchParams.get('sort')).toBe('liquidity');
    expect(u.searchParams.get('dir')).toBe('asc');
    expect(u.searchParams.get('maxAgeHours')).toBe('24');
    expect(new URL(indexUrl({ ...req, sort: 'rank' }), 'https://x.test').searchParams.has('sort')).toBe(false);
  });
});

describe('fetchIndexPage', () => {
  it('returns the page when the index has enough pools', async () => {
    const got = await fetchIndexPage(req, reply({ rows: [row(1)], total: 2000, page: 2, size: 50, pages: 40, note: 'n' }));
    expect(got).toMatchObject({ total: 2000, page: 2, pages: 40, note: 'n' });
  });
  it('is null (the outside feed fills in) when the index is thin, errored or unreachable', async () => {
    expect(await fetchIndexPage(req, reply({ rows: [row(1)], total: INDEX_MIN_TOTAL - 1, page: 1, size: 50, pages: 1 }))).toBeNull();
    expect(await fetchIndexPage(req, reply({ rows: [], total: 0, error: 'index' }))).toBeNull();
    expect(await fetchIndexPage(req, reply({}, 500))).toBeNull();
    expect(await fetchIndexPage(req, (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });
  it('a page past the end is asked again as the last page', async () => {
    const pagesAsked: string[] = [];
    const f = (async (url: string) => {
      const page = new URL(url, 'https://x.test').searchParams.get('page');
      pagesAsked.push(page!);
      return new Response(JSON.stringify(page === '9' ? { rows: [], total: 120, page: 9, size: 50, pages: 3 } : { rows: [row(1)], total: 120, page: 3, size: 50, pages: 3 }));
    }) as unknown as typeof fetch;
    const got = await fetchIndexPage({ ...req, page: 9 }, f);
    expect(pagesAsked).toEqual(['9', '3']);
    expect(got?.page).toBe(3);
  });
});

describe('pager numbers', () => {
  it('says Showing 1-50 of N', () => {
    expect(showingText(1, 50, 22431, 50)).toBe('Showing 1-50 of 22,431');
    expect(showingText(3, 100, 250, 50)).toBe('Showing 201-250 of 250');
    expect(showingText(1, 50, 0, 0)).toBe('Showing 0 of 0');
    // Two rows dropped by the dead/duplicate rules: the range still follows the page.
    expect(showingText(1, 50, 399, 48)).toBe('Showing 1-50 of 399');
    expect(showingText(8, 50, 399, 49)).toBe('Showing 351-399 of 399');
  });
  it('shows the ends and the neighbours with gaps', () => {
    expect(pageButtons(1, 3)).toEqual([1, 2, 3]);
    expect(pageButtons(1, 448)).toEqual([1, 2, 3, 4, null, 448]);
    expect(pageButtons(100, 448)).toEqual([1, null, 99, 100, 101, null, 448]);
    expect(pageButtons(448, 448)).toEqual([1, null, 445, 446, 447, 448]);
  });
});

describe('page size memory', () => {
  const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
  it('defaults to 50, remembers 100, and ignores a value that is not a choice', () => {
    const s = store();
    expect(loadPageSize(s)).toBe(50);
    savePageSize(s, 100);
    resetPageSizeMemory();
    expect(loadPageSize(s)).toBe(100);
    resetPageSizeMemory();
    s.setItem('aretia-market-page-size-v1', '75');
    expect(loadPageSize(s)).toBe(50);
  });
  it('works when storage refuses', () => {
    const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => undefined };
    savePageSize(broken, 100);
    expect(loadPageSize(broken)).toBe(100);
  });
});

describe('column sorting', () => {
  it('the server sorts the whole list by liquidity, volume, age and change', () => {
    expect(serverSort('liquidity', 'desc')).toEqual({ sort: 'liquidity', dir: 'desc' });
    expect(serverSort('age', 'asc')).toEqual({ sort: 'new', dir: 'desc' });
    expect(serverSort('h1', 'desc')).toEqual({ sort: 'change', dir: 'desc', window: 'h1' });
    expect(serverSort('price', 'desc')).toBeNull();
  });
  it('covers every indexed network and all networks', () => {
    expect(['', 'bnb', 'solana', 'base'].every((c) => indexCovers(c as never))).toBe(true);
  });
});
