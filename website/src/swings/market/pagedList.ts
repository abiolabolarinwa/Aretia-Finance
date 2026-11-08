/**
 * The Markets page's side of the index-backed lists: the request to Aretia's paged list, the rule for when it is good enough to be
 * the list, the page-size choice kept in this browser, and the numbers the pager shows. Pure apart from the one `fetch`.
 */
import type { StorageLike } from '../history.js';
import type { ChainId } from '../core/types.js';
/** The networks the Market Indexer follows (the same list as mi/chains.ts, kept here so the page does not load the indexer's node settings). */
const INDEXED_CHAINS: readonly string[] = ['solana', 'ethereum', 'base', 'bnb', 'polygon', 'robinhood'];
import type { MarketRow } from './types.js';

export type IndexKind = 'trending' | 'top' | 'gainers' | 'new' | 'liquidity';
export type IndexWindow = 'm5' | 'h1' | 'h6' | 'h24';
export type IndexSort = 'rank' | 'liquidity' | 'volume' | 'new' | 'change';

export interface IndexPage {
  rows: MarketRow[];
  total: number;
  page: number;
  size: number;
  pages: number;
  note: string;
}

/** An index list with fewer pools than this is too thin to stand alone: the outside feed fills the list instead. */
export const INDEX_MIN_TOTAL = 25;
export const PAGE_SIZE_CHOICES = [50, 100] as const;
const STORED_AS = 'aretia-market-page-size-v1';
let remembered: number | null = null;

export function loadPageSize(storage: StorageLike | null): number {
  if (remembered !== null) return remembered;
  try {
    const v = Number(storage?.getItem(STORED_AS));
    if ((PAGE_SIZE_CHOICES as readonly number[]).includes(v)) return v;
  } catch {
    // storage unavailable: the default stands
  }
  return 50;
}
export function savePageSize(storage: StorageLike | null, size: number): void {
  remembered = size;
  try {
    storage?.setItem(STORED_AS, String(size));
  } catch {
    // kept in memory for this visit
  }
}
export function resetPageSizeMemory(): void {
  remembered = null;
}

/** Every network the index follows is asked of the index first; "all networks" is the index across all of them. */
export const indexCovers = (chain: '' | ChainId): boolean => chain === '' || INDEXED_CHAINS.includes(chain);

export interface IndexRequest {
  kind: IndexKind;
  chain: '' | ChainId;
  window: IndexWindow;
  sort?: IndexSort;
  dir?: 'asc' | 'desc';
  page: number;
  size: number;
  minLiquidityUsd: number;
  maxAgeHours?: number;
}

export function indexUrl(r: IndexRequest): string {
  const q = new URLSearchParams({ src: 'index', kind: r.kind, window: r.window, page: String(r.page), size: String(r.size), minLiq: String(Math.max(0, Math.floor(r.minLiquidityUsd))) });
  if (r.chain) q.set('chain', r.chain);
  if (r.sort && r.sort !== 'rank') {
    q.set('sort', r.sort);
    q.set('dir', r.dir ?? 'desc');
  }
  if (r.maxAgeHours && r.maxAgeHours > 0) q.set('maxAgeHours', String(Math.floor(r.maxAgeHours)));
  return `/api/swings-market?${q}`;
}

/**
 * One page of the index's list, or null when the index cannot stand alone for it (unreachable, not set up, or fewer than
 * INDEX_MIN_TOTAL pools): the page then keeps to its other source. A page past the end is asked again for the last page.
 */
export async function fetchIndexPage(r: IndexRequest, fetchImpl: typeof fetch = (...a) => fetch(...a), signal?: AbortSignal): Promise<IndexPage | null> {
  try {
    const res = await fetchImpl(indexUrl(r), { signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<IndexPage> & { error?: string };
    if (body.error || !Array.isArray(body.rows) || typeof body.total !== 'number' || body.total < INDEX_MIN_TOTAL) return null;
    if (body.rows.length === 0 && r.page > 1 && typeof body.pages === 'number' && body.pages >= 1) return fetchIndexPage({ ...r, page: body.pages }, fetchImpl, signal);
    return { rows: body.rows, total: body.total, page: typeof body.page === 'number' ? body.page : r.page, size: typeof body.size === 'number' ? body.size : r.size, pages: typeof body.pages === 'number' ? body.pages : Math.max(1, Math.ceil(body.total / r.size)), note: typeof body.note === 'string' ? body.note : '' };
  } catch {
    return null;
  }
}

/** "Showing 1-50 of 22,431". */
export function showingText(page: number, size: number, total: number, onPage: number): string {
  if (total === 0 || onPage === 0) return 'Showing 0 of 0';
  const from = (page - 1) * size + 1;
  // The range is the page's place in the whole list, so a page that lost a row to the dead/duplicate rules still reads 1-50, and page 2 starts at 51.
  return `Showing ${from.toLocaleString('en-US')}-${Math.min(total, page * size).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
}

/** The page buttons to draw: the first, the last and the neighbours of the current page, with null for a gap. */
export function pageButtons(page: number, pages: number): (number | null)[] {
  const want = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) for (let i = 1; i <= Math.min(4, pages); i++) want.add(i);
  if (page >= pages - 2) for (let i = Math.max(1, pages - 3); i <= pages; i++) want.add(i);
  const list = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  list.forEach((n, i) => {
    if (i > 0 && n - list[i - 1]! > 1) out.push(null);
    out.push(n);
  });
  return out;
}

/** The server-side sort a column header asks for, or null when the column can only be sorted within the page. */
export function serverSort(key: string, dir: 'asc' | 'desc'): { sort: IndexSort; dir: 'asc' | 'desc'; window?: IndexWindow } | null {
  switch (key) {
    case 'liquidity': return { sort: 'liquidity', dir };
    case 'volume': return { sort: 'volume', dir };
    // A younger pool has a smaller age, so ascending age is newest first.
    case 'age': return { sort: 'new', dir: dir === 'asc' ? 'desc' : 'asc' };
    case 'm5': case 'h1': case 'h6': case 'h24': return { sort: 'change', dir, window: key };
    default: return null;
  }
}
