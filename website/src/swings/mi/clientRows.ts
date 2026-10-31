/**
 * Turns the Market Indexer's API answers into the rows and trades the wallet's existing tables already draw. Pure. Nothing is
 * invented: a number the index does not state stays null and is drawn as a dash.
 */
import type { MarketRow } from '../market/types.js';
import type { Trade } from '../charts/trades.js';
import type { ChainId } from '../core/types.js';
import type { PoolDto } from './dto.js';
import { formatUnits, parseRaw } from './math.js';

/** An EVM address (lower-case) or a Solana public key (base58, case-sensitive). */
const ADDRESS = /^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
/** An EVM transaction hash or a Solana signature. */
const TX_ID = /^(0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{64,100})$/;
const ago = (iso: string | null, now: number): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
};
const sum = (w: { m5: number; h1: number; h6: number; h24: number } | null | undefined): number | null => (w ? w.h24 : null);

/** Market rows for the Aretia Index lists. Entries that are not well-formed are dropped. */
export function marketRowsFromPools(list: unknown, now: number): MarketRow[] {
  if (!Array.isArray(list)) return [];
  const rows: MarketRow[] = [];
  for (const raw of list) {
    const p = raw as PoolDto | null;
    if (!p || typeof p !== 'object' || !ADDRESS.test(p.address ?? '') || !ADDRESS.test(p.base?.address ?? '')) continue;
    const buys = sum(p.txns?.buys);
    const sells = sum(p.txns?.sells);
    rows.push({
      chain: p.chain as ChainId,
      address: p.base.address,
      symbol: p.base.symbol || p.base.address.slice(0, 6),
      quoteSymbol: p.quote.symbol,
      name: p.base.name,
      icon: null,
      decimals: p.base.decimals,
      pool: p.address,
      priceUsd: p.price?.usd ?? null,
      capUsd: null,
      ageMs: ago(p.createdAt, now),
      txns24h: buys !== null && sells !== null ? buys + sells : null,
      volume24hUsd: p.volume?.usd?.h24 ?? null,
      traders24h: null,
      change: { m5: p.changePct?.m5 ?? null, h1: p.changePct?.h1 ?? null, h6: p.changePct?.h6 ?? null, h24: p.changePct?.h24 ?? null },
      liquidityUsd: p.liquidity?.usd ?? null,
      risk: null,
      fresh: true,
      indexed: { quoteIsDollar: p.quoteIsDollar === true, evidence: p.evidence },
    });
  }
  return rows;
}

interface TradeAnswer {
  data?: { id: string; unix: number; side: string; price: string; baseAmount: string; quoteAmount: string; account: string }[];
  meta?: { baseDecimals?: number; quoteDecimals?: number };
}

/**
 * Trades of an indexed pool in the shape the Transactions table draws. Amounts are converted from raw integers with exact
 * decimal arithmetic; the dollar value and price are given only when the pool is quoted in a dollar stablecoin.
 */
export function tradesFromIndexed(body: unknown, quoteIsDollar: boolean): Trade[] {
  const a = body as TradeAnswer | null;
  if (!a || !Array.isArray(a.data) || typeof a.meta?.baseDecimals !== 'number' || typeof a.meta.quoteDecimals !== 'number') return [];
  const out: Trade[] = [];
  for (const t of a.data) {
    const base = parseRaw(t.baseAmount);
    const quote = parseRaw(t.quoteAmount);
    if (base === null || quote === null || (t.side !== 'buy' && t.side !== 'sell') || !Number.isFinite(t.unix) || !ADDRESS.test(t.account ?? '')) continue;
    const txHash = t.id.split(':')[0] ?? '';
    if (!TX_ID.test(txHash)) continue;
    const quoteAmount = Number(formatUnits(quote, a.meta.quoteDecimals));
    out.push({
      t: t.unix * 1000,
      kind: t.side,
      usd: quoteIsDollar ? quoteAmount : Number.NaN,
      tokenAmount: Number(formatUnits(base, a.meta.baseDecimals)),
      quoteAmount,
      priceUsd: quoteIsDollar && Number.isFinite(Number(t.price)) ? Number(t.price) : null,
      trader: t.account,
      tx: txHash,
    });
  }
  return out;
}

export async function fetchIndexedTrades(chain: string, pool: string, quoteIsDollar: boolean, fetchImpl: typeof fetch = (...a) => fetch(...a), signal?: AbortSignal): Promise<Trade[]> {
  const res = await fetchImpl(`/api/v1/pools/${chain}/${pool}/trades?limit=100`, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 429 ? 'The index is busy. The trades will appear shortly.' : 'The trades could not be loaded.');
  return tradesFromIndexed(await res.json(), quoteIsDollar);
}

export async function fetchIndexedRows(kind: 'new' | 'trending', chain: string, now: number, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<MarketRow[]> {
  const q = new URLSearchParams({ limit: '100' });
  if (chain) q.set('chain', chain);
  const res = await fetchImpl(`/api/v1/pools/${kind}?${q}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 503 ? 'Aretia’s market index is not set up yet.' : 'Aretia’s market index is unavailable right now.');
  const body = (await res.json()) as { data?: unknown };
  const list = kind === 'trending' ? (body.data as { ranked?: unknown } | undefined)?.ranked : body.data;
  return marketRowsFromPools(list, now);
}

/** Most index rows a Markets list takes in; at 100 a page that is thirty requests, made one after another. */
export const INDEX_MAX_ROWS = 3000;
const INDEX_PAGE = 100;
const INDEX_TTL_MS = 60_000;
const indexCache = new Map<string, { at: number; rows: MarketRow[] }>();

/**
 * Pages through the index's newest markets by cursor, for a Markets list to add to what the market feed gave. A failed page
 * ends the walk and what was read so far is kept, so a busy index never empties a list. Answers are kept for a minute, so the
 * list's own refresh does not read thirty pages again.
 */
export async function fetchIndexedPages(
  chain: string,
  now: number,
  opts: { max?: number; fetchImpl?: typeof fetch; onPage?: (rows: MarketRow[]) => void } = {},
): Promise<MarketRow[]> {
  const max = Math.min(opts.max ?? INDEX_MAX_ROWS, INDEX_MAX_ROWS);
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const hit = indexCache.get(chain);
  if (hit && now - hit.at < INDEX_TTL_MS) return hit.rows;
  const rows: MarketRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < Math.ceil(max / INDEX_PAGE); page++) {
    const q = new URLSearchParams({ limit: String(INDEX_PAGE) });
    if (chain) q.set('chain', chain);
    if (cursor) q.set('cursor', cursor);
    try {
      const res = await fetchImpl(`/api/v1/pools/new?${q}`, { headers: { accept: 'application/json' } });
      if (!res.ok) break;
      const body = (await res.json()) as { data?: unknown; meta?: { nextCursor?: unknown } };
      rows.push(...marketRowsFromPools(body.data, now));
      opts.onPage?.(rows);
      cursor = typeof body.meta?.nextCursor === 'string' && body.meta.nextCursor ? body.meta.nextCursor : null;
    } catch {
      break;
    }
    if (!cursor) break;
  }
  const kept = rows.slice(0, max);
  if (kept.length > 0) indexCache.set(chain, { at: now, rows: kept });
  return kept;
}

/** `base` first, then the index rows it does not already hold (one row per token, matched on network and address). */
export function mergeIndexRows(base: readonly MarketRow[], extra: readonly MarketRow[]): MarketRow[] {
  const key = (r: MarketRow): string => `${r.chain}:${r.chain === 'solana' ? r.address : r.address.toLowerCase()}`;
  const seen = new Set(base.map(key));
  const added: MarketRow[] = [];
  for (const r of extra) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    added.push(r);
  }
  return [...base, ...added];
}

/** A list read from the index is used as the main list (instead of the outside feed) only when it holds at least this many markets. */
export const NATIVE_MIN_ROWS = 25;

/**
 * The index's own answer for a Markets list: trending, top, gainers or new, for one network or all of them. Null when the index is
 * unreachable, not set up, or too small to stand in for the feed (fewer than NATIVE_MIN_ROWS): the list then keeps using the feed.
 */
export async function fetchNativeList(kind: 'trending' | 'top' | 'gainers' | 'new', chain: string, window: string, now: number, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<MarketRow[] | null> {
  try {
    const q = new URLSearchParams({ limit: '100' });
    if (chain) q.set('chain', chain);
    if (kind === 'gainers' && ['m5', 'h1', 'h6', 'h24'].includes(window)) q.set('window', window);
    const res = await fetchImpl(`/api/v1/pools/${kind}?${q}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    const list = kind === 'trending' ? (body.data as { ranked?: unknown } | undefined)?.ranked : body.data;
    const rows = marketRowsFromPools(list, now);
    return rows.length >= NATIVE_MIN_ROWS ? rows : null;
  } catch {
    return null;
  }
}

const asked = new Set<string>();

/**
 * Tells the index about a market it does not follow, once per page load, so that it is read from then on (and joins the index's
 * lists). Fire and forget: a failure changes nothing on screen.
 */
export function trackMarket(row: Pick<MarketRow, 'chain' | 'pool' | 'indexed'>, fetchImpl: typeof fetch = (...a) => fetch(...a)): void {
  if (row.indexed || !row.pool) return;
  const key = `${row.chain}:${row.pool}`;
  if (asked.has(key)) return;
  asked.add(key);
  void fetchImpl('/api/v1/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: row.chain, pool: row.pool }) }).catch(() => undefined);
}
